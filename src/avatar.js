// Avatar 3D (VRM 1.0): carga, encuadre, vida básica, poses por estado y alas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const FPS = 30;
const ARM_DOWN = 1.32;     // brazos en descanso, pegados al cuerpo
const ARM_FORWARD = -0.12; // un poco hacia delante para no atravesar el vestido

// Por estado: expresión, velocidad del balanceo, velocidad del aleteo e inclinación de la cabeza
const POSES = {
  idle:    { expr: 'relaxed',   sway: 0.8, flap: 3,  tilt: 0 },
  working: { expr: 'neutral',   sway: 2.2, flap: 14, tilt: 0.18 },
  waiting: { expr: 'surprised', sway: 1.2, flap: 7,  tilt: 0 },
  done:    { expr: 'happy',     sway: 1.2, flap: 6,  tilt: 0 },
  error:   { expr: 'sad',       sway: 0.6, flap: 2,  tilt: 0 },
  thinking: { expr: 'neutral',  sway: 1.0, flap: 5,  tilt: 0.2 }, // pensando una respuesta de la charla
  // escuchando: atenta (un poco de sorpresa) e inclinada hacia delante
  listening: { expr: 'surprised', weight: 0.3, sway: 0.5, flap: 8, tilt: 0, lean: 0.14 },
};
const EXPRESSIONS = ['relaxed', 'neutral', 'surprised', 'happy', 'sad'];

// Lo que el resto del renderer le dice al avatar; se lee en cada cuadro
// mouthLevel: función que da el volumen de la voz (0 a 1) mientras suena un audio; si no, null
// greeting: saluda con el brazo y cara feliz, sea cual sea el estado
export const mood = { state: 'idle', asleep: false, talking: false, mouthLevel: null, greeting: false };

let vrm = null;
let renderer, scene, camera, lookTarget;
let wings = [];
let metersPerPx = 0.005, centerY = 0.8;
const look = new THREE.Vector3(0, 1.3, 1);   // hacia dónde mira (se suaviza)
const weights = Object.fromEntries(EXPRESSIONS.map((n) => [n, 0]));
let swayPhase = 0, flapPhase = 0, mouth = 0;
let nextBlink = 3, blinkStart = -1;
let hopLeft = 0;
let lean = 0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const bone = (name) => vrm.humanoid.getNormalizedBoneNode(name);

export function hop() { hopLeft = 1; }

// Posición del cursor en píxeles respecto al centro del canvas (viene del proceso principal)
export function lookAtCursor(dx, dy) {
  look.set(clamp(dx * metersPerPx, -2, 2), clamp(centerY - dy * metersPerPx, -1, 3.5), 1);
}

function makeWing(side) {
  const upper = new THREE.Shape();
  upper.moveTo(0, 0);
  upper.bezierCurveTo(0.10, 0.35, 0.30, 0.55, 0.48, 0.50);
  upper.bezierCurveTo(0.50, 0.25, 0.30, 0.02, 0, 0);
  const lower = new THREE.Shape();
  lower.moveTo(0, 0);
  lower.bezierCurveTo(0.20, -0.02, 0.36, -0.15, 0.32, -0.32);
  lower.bezierCurveTo(0.15, -0.28, 0.03, -0.12, 0, 0);
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry([upper, lower]),
    new THREE.MeshBasicMaterial({ color: 0xb9a6ff, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false })
  );
  const pivot = new THREE.Group();
  pivot.position.set(side * 0.03, 0.05, -0.09); // en la espalda
  pivot.scale.x = side;
  pivot.add(mesh);
  pivot.userData.side = side;
  return pivot;
}

export async function initAvatar(canvas, buffer) {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0); // fondo totalmente transparente
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 1.15);
  sun.position.set(0, 0.4, 1); // de frente, para que la cara no quede en sombra
  scene.add(sun, new THREE.AmbientLight(0xffffff, 0.5));
  lookTarget = new THREE.Object3D();
  scene.add(lookTarget);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer, '');
  vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  scene.add(vrm.scene);
  vrm.lookAt.target = lookTarget;

  // Encuadre cercano: desde la cabeza (con aire para el saltito) hasta media pierna
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const body = box.max.y - box.min.y;
  const height = body * 1.0;
  centerY = box.max.y + body * 0.1 - height / 2;
  const fov = 20;
  camera = new THREE.PerspectiveCamera(fov, canvas.clientWidth / canvas.clientHeight, 0.1, 30);
  camera.position.set(0, centerY, (height / 2) / Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  camera.lookAt(0, centerY, 0);
  metersPerPx = height / canvas.clientHeight;

  // El modelo viene en pose T: brazos abajo desde el primer cuadro
  bone('leftUpperArm').rotation.set(ARM_FORWARD, 0, -ARM_DOWN);
  bone('rightUpperArm').rotation.set(ARM_FORWARD, 0, ARM_DOWN);

  const back = bone('chest') || bone('upperChest') || bone('spine');
  wings = [makeWing(1), makeWing(-1)];
  back.add(...wings);

  let last = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = (now - last) / 1000;
    if (dt < 1 / FPS - 0.002) return; // límite de 30 fps
    last = now;
    update(Math.min(dt, 0.1), now / 1000);
    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}

function update(dt, t) {
  const pose = POSES[mood.state] || POSES.idle;
  const asleep = mood.asleep;
  const k = 1 - Math.exp(-8 * dt); // suavizado entre poses
  const ease = (obj, axis, target) => { obj.rotation[axis] += (target - obj.rotation[axis]) * k; };
  swayPhase += dt * (asleep ? 0.5 : pose.sway);
  flapPhase += dt * (asleep ? 1.5 : pose.flap);

  // Expresión del estado
  const em = vrm.expressionManager;
  for (const name of EXPRESSIONS) {
    const special = asleep || mood.greeting;
    const wanted = asleep ? 'relaxed' : mood.greeting ? 'happy' : pose.expr;
    const target = name === wanted ? (special ? 1 : pose.weight ?? 1) : 0;
    weights[name] += (target - weights[name]) * k;
    em.setValue(name, weights[name]);
  }

  // Parpadeo aleatorio cada 2 a 6 s (dormida: ojos cerrados)
  let blink = asleep ? 1 : 0;
  if (!asleep) {
    if (blinkStart < 0 && t > nextBlink) blinkStart = t;
    if (blinkStart >= 0) {
      const p = (t - blinkStart) / 0.18;
      if (p >= 1) { blinkStart = -1; nextBlink = t + 2 + Math.random() * 4; }
      else blink = Math.sin(Math.PI * p);
    }
  }
  em.setValue('blink', blink);

  // Boca: sigue el volumen real del audio; con speechSynthesis (sin audio que medir) oscila
  if (mood.mouthLevel) mouth += (mood.mouthLevel() - mouth) * (1 - Math.exp(-25 * dt));
  else mouth = mood.talking ? 0.5 + 0.5 * Math.sin(t * 16) : mouth * (1 - k);
  em.setValue('aa', mouth);

  // Respiración y balanceo
  const sway = Math.sin(swayPhase);
  const breath = Math.sin(t * 1.7);
  bone('hips').rotation.z = sway * 0.03;
  bone('hips').rotation.y = Math.sin(swayPhase * 0.5) * 0.05;
  lean += ((asleep ? 0 : pose.lean || 0) - lean) * k;
  bone('spine').rotation.x = breath * 0.025 + lean;
  bone('spine').rotation.z = -sway * 0.02;
  const chest = bone('chest');
  if (chest) chest.rotation.x = Math.sin(t * 1.7 + 0.5) * 0.02;

  // Cabeza: inclinada al trabajar, caída al dormir; gira un poco hacia el cursor
  lookTarget.position.lerp(look, k);
  const head = bone('head'), neck = bone('neck') || head;
  ease(head, 'z', pose.tilt);
  ease(head, 'x', asleep ? 0.3 : pose.tilt * 0.6 - lean * 0.6); // al inclinarse sigue mirando al frente
  ease(neck, 'y', asleep ? 0 : clamp(lookTarget.position.x, -1, 1) * 0.3);

  // Brazos: abajo; en waiting saluda con el derecho
  const waving = (mood.state === 'waiting' || mood.greeting) && !asleep;
  ease(bone('leftUpperArm'), 'z', -ARM_DOWN + breath * 0.015);
  ease(bone('rightUpperArm'), 'z', waving ? -0.35 : ARM_DOWN - breath * 0.015);
  ease(bone('rightUpperArm'), 'x', waving ? 0 : ARM_FORWARD);
  ease(bone('rightLowerArm'), 'z', waving ? -1.2 + Math.sin(t * 9) * 0.35 : 0);

  // Flota, y da dos saltitos cuando hay aviso
  let y = Math.sin(t * 1.3) * 0.012;
  if (hopLeft > 0) {
    y += Math.abs(Math.sin((1 - hopLeft) * 2 * Math.PI)) * 0.09;
    hopLeft = Math.max(0, hopLeft - dt);
  }
  vrm.scene.position.y = y;

  // Alas
  for (const w of wings) w.rotation.y = w.userData.side * (0.35 + Math.sin(flapPhase) * 0.4);

  vrm.update(dt); // huesos, mirada, expresiones y física del pelo
}
