export function installCPUBackend({
  THREE,
  scene,
  camera,
  content,
  renderGPU
}) {
  const $ = selector => document.querySelector(selector);

  const engineField = document.createElement('div');
  engineField.className = 'field';
  engineField.innerHTML = `
    <label for="renderBackend">Device</label>
    <select id="renderBackend">
      <option value="gpu">GPU — full renderer</option>
      <option value="cpu">CPU — basic preview</option>
    </select>
  `;

  $('#renderSection h2').after(engineField);

  const description = document.createElement('p');
  description.className = 'note';
  description.textContent =
    'CPU renders a scene snapshot in a background worker. ' +
    'Textures, glass, normal maps, and animated meshes are not supported.';

  engineField.after(description);

  const dialog = document.createElement('dialog');
  dialog.id = 'cpuOutput';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div>
        <h2>CPU Path-Traced Preview</h2>
        <p id="cpuStatus">Ready</p>
      </div>
      <button id="cpuClose" aria-label="Close CPU output">✕</button>
    </div>

    <div class="cpu-image-wrap">
      <canvas id="cpuCanvas"></canvas>
    </div>

    <div class="cpu-controls">
      <label>
        Output width
        <select id="cpuWidth">
          <option value="320">320 px — fast</option>
          <option value="480" selected>480 px</option>
          <option value="640">640 px — slower</option>
          <option value="960">960 px — very slow</option>
        </select>
      </label>

      <div class="two-buttons">
        <button id="cpuPause">⏸ Pause</button>
        <button id="cpuRestart">↻ Restart</button>
      </div>

      <button class="primary full" id="cpuSave">↓ Save CPU PNG</button>

      <p class="note">
        Uses the scene and camera captured when rendering starts.
        Samples and bounce limits come from Render Properties.
        Close this window to edit the scene.
      </p>
    </div>
  `;

  document.body.append(dialog);

  const canvas = $('#cpuCanvas');
  const context = canvas.getContext('2d', { alpha: false });

  let worker = null;
  let paused = false;
  let startedAt = 0;

  function stopWorker() {
    worker?.terminate();
    worker = null;
    paused = false;
    $('#cpuPause').textContent = '⏸ Pause';
  }

  dialog.addEventListener('close', stopWorker);
  $('#cpuClose').onclick = () => dialog.close();

  function serializeScene() {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    const materials = [];
    const materialIndices = new Map();
    const triangles = [];
    const lights = [];

    function materialIndex(material) {
      if (materialIndices.has(material)) {
        return materialIndices.get(material);
      }

      const color = material?.color || new THREE.Color('#b6bec8');
      const emissive = material?.emissive || new THREE.Color(0);
      const emissionPower = material?.emissiveIntensity ?? 0;

      const index = materials.length;

      materials.push({
        color: color.toArray(),
        emission: emissive.toArray().map(value => value * emissionPower),
        roughness: material?.roughness ?? 0.6,
        metalness: material?.metalness ?? 0
      });

      materialIndices.set(material, index);
      return index;
    }

    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();

    content.traverseVisible(object => {
      if (object.isPointLight) {
        lights.push({
          type: 'point',
          position: object.getWorldPosition(new THREE.Vector3()).toArray(),
          color: object.color.toArray(),
          intensity: object.intensity,
          distance: object.distance || 0
        });
      }

      if (object.isRectAreaLight) {
        const rotation = object.getWorldQuaternion(new THREE.Quaternion());

        lights.push({
          type: 'area',
          position: object.getWorldPosition(new THREE.Vector3()).toArray(),
          color: object.color.toArray(),
          intensity: object.intensity,
          width: object.width,
          height: object.height,
          right: new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).toArray(),
          up: new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).toArray(),
          normal: new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).toArray()
        });
      }

      if (!object.isMesh) return;

      const geometry = object.geometry;
      const positions = geometry.attributes.position;
      if (!positions) return;

      const normals = geometry.attributes.normal;
      const index = geometry.index;
      const count = index ? index.count : positions.count;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);

      const drawStart = geometry.drawRange.start || 0;
      const drawEnd = Math.min(
        count,
        drawStart + geometry.drawRange.count
      );

      for (let offset = drawStart; offset + 2 < drawEnd; offset += 3) {
        let material = object.material;

        if (Array.isArray(material)) {
          const group = geometry.groups.find(group =>
            offset >= group.start &&
            offset < group.start + group.count
          );

          material = material[group?.materialIndex || 0];
        }

        if (!material || material.visible === false) continue;

        const p = [];
        const n = [];

        for (let corner = 0; corner < 3; corner++) {
          const vertex = index
            ? index.getX(offset + corner)
            : offset + corner;

          position.fromBufferAttribute(positions, vertex);
          position.applyMatrix4(object.matrixWorld);
          p.push(position.x, position.y, position.z);

          if (normals) {
            normal.fromBufferAttribute(normals, vertex);
            normal.applyMatrix3(normalMatrix).normalize();
            n.push(normal.x, normal.y, normal.z);
          }
        }

        if (!normals || material.flatShading) {
          const a = new THREE.Vector3(...p.slice(0, 3));
          const b = new THREE.Vector3(...p.slice(3, 6));
          const c = new THREE.Vector3(...p.slice(6, 9));

          normal.subVectors(b, a)
            .cross(new THREE.Vector3().subVectors(c, a))
            .normalize();

          n.length = 0;

          for (let i = 0; i < 3; i++) {
            n.push(normal.x, normal.y, normal.z);
          }
        }

        triangles.push({
          p,
          n,
          material: materialIndex(material)
        });
      }
    });

    const matrix = camera.matrixWorld.elements;
    const width = Number($('#cpuWidth').value);
    const height = Math.max(1, Math.round(width / camera.aspect));

    return {
      triangles,
      materials,
      lights,
      width,
      height,
      samples: Number($('#samples').value),
      bounces: Number($('#bounces').value),
      exposure: Number($('#exposure').value),
      environment: Number($('#environmentPower').value),
      camera: {
        position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
        right: [matrix[0], matrix[1], matrix[2]],
        up: [matrix[4], matrix[5], matrix[6]],
        forward: [-matrix[8], -matrix[9], -matrix[10]],
        fov: camera.fov,
        aspect: camera.aspect
      }
    };
  }

  function startCPU() {
    stopWorker();

    if (!dialog.open) dialog.showModal();

    $('#cpuStatus').textContent = 'Preparing scene snapshot…';
    $('#cpuSave').disabled = true;
    $('#cpuPause').disabled = false;

    // Let the dialog become visible before serializing the scene.
    requestAnimationFrame(() => {
      if (!dialog.open) return;

      try {
        const data = serializeScene();

        canvas.width = data.width;
        canvas.height = data.height;

        context.fillStyle = '#17191f';
        context.fillRect(0, 0, canvas.width, canvas.height);

        worker = new Worker(
          new URL('./cpu-worker.js', import.meta.url),
          { type: 'module' }
        );

        startedAt = performance.now();

        worker.onmessage = event => {
          const message = event.data;

          if (message.type === 'status') {
            $('#cpuStatus').textContent = message.text;
          }

          if (message.type === 'image') {
            const image = new ImageData(
              message.pixels,
              message.width,
              message.height
            );

            context.putImageData(image, 0, 0);
            $('#cpuSave').disabled = false;

            const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

            $('#cpuStatus').textContent =
              `${message.sample} / ${data.samples} samples · ` +
              `${data.bounces} bounces · ${seconds}s elapsed`;
          }

          if (message.type === 'done') {
            $('#cpuPause').disabled = true;
            $('#cpuStatus').textContent += ' · Complete';
          }

          if (message.type === 'error') {
            $('#cpuStatus').textContent = message.message;
            $('#cpuPause').disabled = true;
            stopWorker();
          }
        };

        worker.onerror = event => {
          $('#cpuStatus').textContent =
            'CPU renderer failed: ' + event.message;

          $('#cpuPause').disabled = true;
          stopWorker();
        };

        worker.postMessage({ type: 'start', data });
      } catch (error) {
        $('#cpuStatus').textContent = error.message;
      }
    });
  }

  $('#cpuPause').onclick = () => {
    if (!worker) return;

    paused = !paused;
    worker.postMessage({ type: 'pause', value: paused });

    $('#cpuPause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  };

  $('#cpuRestart').onclick = startCPU;

  $('#cpuSave').onclick = () => {
    canvas.toBlob(blob => {
      if (!blob) return;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = 'luma-cpu-render.png';
      link.click();

      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }, 'image/png');
  };

  // Start Render now respects the selected device.
  $('#startRender').onclick = () => {
    if ($('#renderBackend').value === 'cpu') {
      startCPU();
    } else {
      renderGPU();
    }
  };

  // Rendered/Output buttons also respect the selected device.
  document.querySelectorAll(
    '[data-mode="rendered"], [data-mode="output"]'
  ).forEach(button => {
    const originalAction = button.onclick;

    button.onclick = event => {
      if ($('#renderBackend').value === 'cpu') {
        startCPU();
      } else {
        originalAction?.call(button, event);
      }
    };
  });

  const originalRestart = $('#restartRender').onclick;

  $('#restartRender').onclick = event => {
    if ($('#renderBackend').value === 'cpu') {
      startCPU();
    } else {
      originalRestart?.call($('#restartRender'), event);
    }
  };

  const originalPause = $('#pauseRender').onclick;

  $('#pauseRender').onclick = event => {
    if ($('#renderBackend').value === 'cpu') {
      startCPU();
    } else {
      originalPause?.call($('#pauseRender'), event);
    }
  };
}
