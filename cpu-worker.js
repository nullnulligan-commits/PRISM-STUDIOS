let paused = false;

const EPSILON = 0.0001;
const PI = Math.PI;

const add = (a, b) => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2]
];

const sub = (a, b) => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];

const scale = (a, s) => [
  a[0] * s,
  a[1] * s,
  a[2] * s
];

const dot = (a, b) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return scale(vector, 1 / length);
}

function reflect(direction, normal) {
  return sub(direction, scale(normal, 2 * dot(direction, normal)));
}

function randomHemisphere(normal) {
  const r1 = Math.random();
  const r2 = Math.random();

  const angle = 2 * PI * r1;
  const radius = Math.sqrt(r2);

  const tangent = normalize(cross(
    Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
    normal
  ));

  const bitangent = cross(normal, tangent);

  return normalize(add(
    add(
      scale(tangent, Math.cos(angle) * radius),
      scale(bitangent, Math.sin(angle) * radius)
    ),
    scale(normal, Math.sqrt(1 - r2))
  ));
}

function prepareTriangle(triangle) {
  triangle.a = triangle.p.slice(0, 3);
  triangle.b = triangle.p.slice(3, 6);
  triangle.c = triangle.p.slice(6, 9);

  triangle.edge1 = sub(triangle.b, triangle.a);
  triangle.edge2 = sub(triangle.c, triangle.a);

  triangle.min = [0, 1, 2].map(axis =>
    Math.min(triangle.a[axis], triangle.b[axis], triangle.c[axis])
  );

  triangle.max = [0, 1, 2].map(axis =>
    Math.max(triangle.a[axis], triangle.b[axis], triangle.c[axis])
  );

  triangle.center = [0, 1, 2].map(axis =>
    (triangle.min[axis] + triangle.max[axis]) * 0.5
  );

  return triangle;
}

function buildBVH(triangles) {
  if (!triangles.length) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const triangle of triangles) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], triangle.min[axis]);
      max[axis] = Math.max(max[axis], triangle.max[axis]);
    }
  }

  if (triangles.length <= 8) {
    return { min, max, triangles };
  }

  const extents = sub(max, min);
  let axis = 0;

  if (extents[1] > extents[axis]) axis = 1;
  if (extents[2] > extents[axis]) axis = 2;

  triangles.sort((a, b) => a.center[axis] - b.center[axis]);

  const middle = Math.floor(triangles.length / 2);

  return {
    min,
    max,
    left: buildBVH(triangles.slice(0, middle)),
    right: buildBVH(triangles.slice(middle))
  };
}

function intersectsBox(node, origin, direction, maximum) {
  let near = EPSILON;
  let far = maximum;

  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (
        origin[axis] < node.min[axis] ||
        origin[axis] > node.max[axis]
      ) return false;

      continue;
    }

    let first = (node.min[axis] - origin[axis]) / direction[axis];
    let second = (node.max[axis] - origin[axis]) / direction[axis];

    if (first > second) [first, second] = [second, first];

    near = Math.max(near, first);
    far = Math.min(far, second);

    if (far < near) return false;
  }

  return true;
}

function intersectTriangle(triangle, origin, direction, maximum) {
  const p = cross(direction, triangle.edge2);
  const determinant = dot(triangle.edge1, p);

  if (Math.abs(determinant) < 1e-10) return null;

  const inverse = 1 / determinant;
  const t = sub(origin, triangle.a);
  const u = dot(t, p) * inverse;

  if (u < 0 || u > 1) return null;

  const q = cross(t, triangle.edge1);
  const v = dot(direction, q) * inverse;

  if (v < 0 || u + v > 1) return null;

  const distance = dot(triangle.edge2, q) * inverse;

  if (distance <= EPSILON || distance >= maximum) return null;

  return { triangle, distance, u, v };
}

function intersectScene(root, origin, direction, maximum = Infinity) {
  if (!root) return null;

  const stack = [root];
  let closest = maximum;
  let result = null;

  while (stack.length) {
    const node = stack.pop();

    if (!intersectsBox(node, origin, direction, closest)) continue;

    if (node.triangles) {
      for (const triangle of node.triangles) {
        const hit = intersectTriangle(
          triangle,
          origin,
          direction,
          closest
        );

        if (hit) {
          closest = hit.distance;
          result = hit;
        }
      }
    } else {
      stack.push(node.left, node.right);
    }
  }

  return result;
}

function hitNormal(hit, direction) {
  const n = hit.triangle.n;
  const w = 1 - hit.u - hit.v;

  let normal = normalize([
    n[0] * w + n[3] * hit.u + n[6] * hit.v,
    n[1] * w + n[4] * hit.u + n[7] * hit.v,
    n[2] * w + n[5] * hit.u + n[8] * hit.v
  ]);

  if (dot(normal, direction) > 0) {
    normal = scale(normal, -1);
  }

  return normal;
}

function environmentColor(direction, strength) {
  const sky = Math.max(0, direction[1]);

  return [
    (.16 + .5 * sky) * strength,
    (.18 + .63 * sky) * strength,
    (.22 + .85 * sky) * strength
  ];
}

function directLighting(root, lights, point, normal, material) {
  const result = [0, 0, 0];
  const diffuseWeight = 1 - material.metalness;

  if (diffuseWeight <= 0) return result;

  const origin = add(point, scale(normal, EPSILON * 4));

  for (const light of lights) {
    let lightPosition = light.position;

    if (light.type === 'area') {
      lightPosition = add(
        add(
          light.position,
          scale(light.right, (Math.random() - .5) * light.width)
        ),
        scale(light.up, (Math.random() - .5) * light.height)
      );
    }

    const delta = sub(lightPosition, origin);
    const distanceSquared = dot(delta, delta);
    const distance = Math.sqrt(distanceSquared);

    if (distance < EPSILON) continue;

    if (
      light.type === 'point' &&
      light.distance > 0 &&
      distance > light.distance
    ) continue;

    const direction = scale(delta, 1 / distance);
    const cosine = Math.max(0, dot(normal, direction));

    if (cosine <= 0) continue;

    let lightFactor = light.intensity / Math.max(distanceSquared, .0001);

    if (light.type === 'area') {
      const lightCosine = Math.max(
        0,
        dot(light.normal, scale(direction, -1))
      );

      if (lightCosine <= 0) continue;

      lightFactor *= light.width * light.height * lightCosine;
    }

    if (intersectScene(
      root,
      origin,
      direction,
      distance - EPSILON * 8
    )) continue;

    for (let channel = 0; channel < 3; channel++) {
      result[channel] +=
        material.color[channel] *
        diffuseWeight *
        light.color[channel] *
        lightFactor *
        cosine / PI;
    }
  }

  return result;
}

function traceRay(root, data, initialOrigin, initialDirection) {
  let origin = initialOrigin;
  let direction = initialDirection;

  const throughput = [1, 1, 1];
  const radiance = [0, 0, 0];

  // One initial surface interaction plus the allowed continuation bounces.
  for (let depth = 0; depth <= data.bounces; depth++) {
    const hit = intersectScene(root, origin, direction);

    if (!hit) {
      const environment = environmentColor(direction, data.environment);

      for (let channel = 0; channel < 3; channel++) {
        radiance[channel] += throughput[channel] * environment[channel];
      }

      break;
    }

    const material = data.materials[hit.triangle.material];
    const point = add(origin, scale(direction, hit.distance));
    const normal = hitNormal(hit, direction);

    const direct = directLighting(
      root,
      data.lights,
      point,
      normal,
      material
    );

    for (let channel = 0; channel < 3; channel++) {
      radiance[channel] += throughput[channel] * (
        material.emission[channel] + direct[channel]
      );
    }

    if (depth === data.bounces) break;

    if (Math.random() < material.metalness) {
      const reflected = normalize(reflect(direction, normal));
      const diffuse = randomHemisphere(normal);
      const roughness = material.roughness * material.roughness;

      direction = normalize(add(
        scale(reflected, 1 - roughness),
        scale(diffuse, roughness)
      ));

      if (dot(direction, normal) <= 0) break;
    } else {
      direction = randomHemisphere(normal);
    }

    for (let channel = 0; channel < 3; channel++) {
      throughput[channel] *= material.color[channel];
    }

    origin = add(point, scale(normal, EPSILON * 4));

    // Russian roulette avoids spending time on paths with little energy.
    if (depth >= 3) {
      const survival = Math.min(.95, Math.max(...throughput));

      if (survival <= 0 || Math.random() > survival) break;

      for (let channel = 0; channel < 3; channel++) {
        throughput[channel] /= survival;
      }
    }
  }

  return radiance;
}

function toneMap(value, exposure) {
  const x = Math.max(0, value * exposure);

  // ACES-style filmic approximation, followed by linear-to-sRGB encoding.
  let mapped = (x * (2.51 * x + .03)) /
    (x * (2.43 * x + .59) + .14);

  mapped = Math.max(0, Math.min(1, mapped));

  const srgb = mapped <= .0031308
    ? mapped * 12.92
    : 1.055 * Math.pow(mapped, 1 / 2.4) - .055;

  return Math.round(srgb * 255);
}

const yieldToMessages = () =>
  new Promise(resolve => setTimeout(resolve, 0));

async function render(data) {
  postMessage({
    type: 'status',
    text: `Building CPU acceleration structure for ${data.triangles.length.toLocaleString()} triangles…`
  });

  const root = buildBVH(data.triangles.map(prepareTriangle));
  const accumulation = new Float32Array(data.width * data.height * 3);
  const camera = data.camera;
  const halfFov = Math.tan(camera.fov * PI / 360);

  for (let sample = 1; sample <= data.samples; sample++) {
    for (let y = 0; y < data.height; y++) {
      if (y % 4 === 0) {
        await yieldToMessages();

        while (paused) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      for (let x = 0; x < data.width; x++) {
        const horizontal =
          ((x + Math.random()) / data.width * 2 - 1) *
          camera.aspect * halfFov;

        const vertical =
          (1 - (y + Math.random()) / data.height * 2) *
          halfFov;

        const direction = normalize(add(
          add(camera.forward, scale(camera.right, horizontal)),
          scale(camera.up, vertical)
        ));

        const color = traceRay(
          root,
          data,
          camera.position,
          direction
        );

        const index = (y * data.width + x) * 3;

        accumulation[index] += color[0];
        accumulation[index + 1] += color[1];
        accumulation[index + 2] += color[2];
      }
    }

    const pixels = new Uint8ClampedArray(data.width * data.height * 4);

    for (let pixel = 0; pixel < data.width * data.height; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        pixels[pixel * 4 + channel] = toneMap(
          accumulation[pixel * 3 + channel] / sample,
          data.exposure
        );
      }

      pixels[pixel * 4 + 3] = 255;
    }

    postMessage({
      type: 'image',
      pixels,
      width: data.width,
      height: data.height,
      sample
    }, [pixels.buffer]);
  }

  postMessage({ type: 'done' });
}

self.onmessage = event => {
  if (event.data.type === 'pause') {
    paused = event.data.value;
  }

  if (event.data.type === 'start') {
    paused = false;

    render(event.data.data).catch(error => {
      postMessage({
        type: 'error',
        message: 'CPU render failed: ' + error.message
      });
    });
  }
};
