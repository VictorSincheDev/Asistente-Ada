// Avatar 3D (VRM 1.0): carga, encuadre, vida básica, clips de animación, poses por código y alas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { clipDesdeFBX, clipDesdeVRMA, enSitio } from './animacion.js';

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
// walking: 1 camina a la derecha, -1 a la izquierda, 0 quieta (la ventana la mueve main)
// walkSpeed: velocidad de la animación de caminar, para que los pies acompañen al desplazamiento
export const mood = { state: 'idle', asleep: false, talking: false, mouthLevel: null, greeting: false, walking: 0, walkSpeed: 1 };

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
const REST = [0, 0, 0];
const _e = new THREE.Euler(), _q = new THREE.Quaternion();

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const bone = (name) => vrm.humanoid.getNormalizedBoneNode(name);
let bones = [];            // huesos humanoides que mueve la pose por código (todos menos los ojos)
let hipsRest = null;       // posición de reposo de las caderas
let alturaCaderas = 1;     // para escalar el desplazamiento de los FBX de Mixamo
// Modelos VRM 0.x: miran al otro lado; rotateVRM0 los gira y las rotaciones de pose cambian de signo en x y z
let flip = 1;
let baseYaw = 0;

// ---------- Clips de animación ----------
// estado → clave del mapa de clips (config.animaciones). Sin clip para el estado, se mueve por código.
const CLIP_DE_ESTADO = { idle: 'idle', working: 'working', waiting: 'waiting', done: 'done', thinking: 'pensar' };
const FUNDIDO = 0.3;          // crossfade entre clips, en segundos
const ESTIRON_MIN_S = 240;    // en idle se estira de vez en cuando (entre 4 y 8 min)
let mixer = null;
const actions = new Map();    // clave → AnimationAction
let playing = null;           // clave del clip que manda (null = movimiento por código)
let oneShot = null;           // { key, until }: clip de una sola vez (estirarse)
let nextStretch = Infinity;
let wasAsleep = false;
const lookOffset = new THREE.Quaternion();

// Carga los clips ([{ key, ext, buffer }]) y reemplaza los anteriores. Devuelve las claves cargadas.
export async function loadClips(list) {
  if (!vrm) return [];
  const clips = new Map();
  for (const { key, ext, buffer } of list) {
    try {
      const clip = ext === 'vrma' ? await clipDesdeVRMA(buffer, vrm) : clipDesdeFBX(buffer, vrm, alturaCaderas);
      clips.set(key, key === 'caminar' ? enSitio(clip, vrm) : clip); // el avance lo pone la ventana
    } catch (e) {
      console.error(`No pude cargar la animación «${key}»:`, e);
    }
  }
  mixer.stopAllAction();
  for (const a of actions.values()) mixer.uncacheClip(a.getClip());
  actions.clear();
  playing = null;
  oneShot = null;
  for (const [key, clip] of clips) {
    const action = mixer.clipAction(clip);
    if (key === 'estirarse') action.setLoop(THREE.LoopOnce, 1);
    actions.set(key, action);
  }
  nextStretch = performance.now() / 1000 + ESTIRON_MIN_S * (1 + Math.random());
  return [...clips.keys()];
}

function startStretch(t) {
  const action = actions.get('estirarse');
  if (!action) return;
  const duration = action.getClip().duration;
  oneShot = { key: 'estirarse', until: t + duration - FUNDIDO };
  nextStretch = t + duration + ESTIRON_MIN_S * (1 + Math.random());
}

// Qué clip toca ahora (null = movimiento por código)
function wantedClip(t) {
  if (mood.walking) return actions.has('caminar') ? 'caminar' : null; // sin clip, flota de lado
  if (mood.asleep) return null;
  if (oneShot && t < oneShot.until) return oneShot.key;
  oneShot = null;
  if (mood.greeting) return actions.has('waiting') ? 'waiting' : null; // sin clip, saluda por código
  if (mood.state === 'idle' && t > nextStretch) startStretch(t);
  if (oneShot) return oneShot.key;
  const key = CLIP_DE_ESTADO[mood.state];
  return actions.has(key) ? key : null;
}

// Cambia de clip con crossfade; hacia el código, el clip se desvanece y la pose por código sigue desde ahí
function switchClip(key) {
  if (key === playing) return;
  const from = playing && actions.get(playing);
  const to = key && actions.get(key);
  if (to) {
    to.reset().setEffectiveTimeScale(key === 'caminar' ? mood.walkSpeed : 1).setEffectiveWeight(1).play();
    if (from) from.crossFadeTo(to, FUNDIDO, false);
    else to.fadeIn(FUNDIDO);
  } else if (from) {
    from.fadeOut(FUNDIDO);
  }
  playing = key;
}

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

// Tras cambiar el tamaño (zoom de la ventana) cambia la densidad de píxeles: se ajusta la resolución
export function resize() {
  if (!renderer) return;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight, false);
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
  VRMUtils.rotateVRM0(vrm); // no hace nada en VRM 1.0
  flip = vrm.meta?.metaVersion === '0' ? -1 : 1;
  baseYaw = vrm.scene.rotation.y;
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  scene.add(vrm.scene);
  vrm.lookAt.target = lookTarget;
  bones = Object.keys(vrm.humanoid.humanBones).filter((n) => n !== 'leftEye' && n !== 'rightEye');
  hipsRest = bone('hips').position.clone();
  vrm.scene.updateMatrixWorld(true);
  alturaCaderas = Math.abs(bone('hips').getWorldPosition(new THREE.Vector3()).y - vrm.scene.position.y);
  mixer = new THREE.AnimationMixer(vrm.scene);

  // Encuadre de cuerpo entero, con aire arriba para el saltito y un poco bajo los pies
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const body = box.max.y - box.min.y;
  const height = body * 1.12;
  centerY = box.min.y - body * 0.02 + height / 2;
  const fov = 20;
  camera = new THREE.PerspectiveCamera(fov, canvas.clientWidth / canvas.clientHeight, 0.1, 30);
  camera.position.set(0, centerY, (height / 2) / Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  camera.lookAt(0, centerY, 0);
  metersPerPx = height / canvas.clientHeight;

  // El modelo viene en pose T: brazos abajo desde el primer cuadro
  bone('leftUpperArm').rotation.set(flip * ARM_FORWARD, 0, flip * -ARM_DOWN);
  bone('rightUpperArm').rotation.set(flip * ARM_FORWARD, 0, flip * ARM_DOWN);

  const back = bone('chest') || bone('upperChest') || bone('spine');
  wings = [makeWing(1), makeWing(-1)];
  const wingRoot = new THREE.Group(); // en VRM 0.x la espalda está del otro lado
  wingRoot.rotation.y = flip < 0 ? Math.PI : 0;
  wingRoot.add(...wings);
  back.add(wingRoot);

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

  // Mirada: los ojos siguen al cursor (vrm.lookAt) y el cuello gira un poco, con clip o sin él
  lookTarget.position.lerp(look, k);
  const lookYaw = asleep ? 0 : clamp(lookTarget.position.x, -1, 1) * 0.3;
  const neck = bone('neck') || bone('head');

  // Clip de animación del estado, si existe; al despertar se estira
  if (wasAsleep && !asleep) startStretch(t);
  wasAsleep = asleep;
  switchClip(wantedClip(t));

  if (!playing) {
    // Movimiento por código: cada hueso se acerca a su objetivo; los que no tienen, al reposo
    const sway = Math.sin(swayPhase);
    const breath = Math.sin(t * 1.7);
    lean += ((asleep ? 0 : pose.lean || 0) - lean) * k;
    const waving = (mood.state === 'waiting' || mood.greeting) && !asleep;
    const target = {
      hips: [0, Math.sin(swayPhase * 0.5) * 0.05, sway * 0.03],
      spine: [breath * 0.025 + lean, 0, -sway * 0.02],
      chest: [Math.sin(t * 1.7 + 0.5) * 0.02, 0, 0],
      // cabeza: inclinada al trabajar, caída al dormir; al inclinarse el cuerpo sigue mirando al frente
      head: [asleep ? 0.3 : pose.tilt * 0.6 - lean * 0.6, 0, pose.tilt],
      leftUpperArm: [ARM_FORWARD, 0, -ARM_DOWN + breath * 0.015],
      // en waiting (o al saludar) levanta el brazo derecho y mueve el antebrazo
      rightUpperArm: waving ? [0, 0, -0.35] : [ARM_FORWARD, 0, ARM_DOWN - breath * 0.015],
      rightLowerArm: waving ? [0, 0, -1.2 + Math.sin(t * 9) * 0.35] : [0, 0, 0],
    };
    if (bone('neck')) target.neck = [0, lookYaw, 0];
    else target.head[1] = lookYaw;
    for (const name of bones) {
      const r = target[name] || REST;
      _q.setFromEuler(_e.set(flip * r[0], r[1], flip * r[2]));
      bone(name).quaternion.slerp(_q, k);
    }
    bone('hips').position.lerp(hipsRest, k);
    mixer.update(dt); // termina el desvanecido del último clip, si lo hay
  } else {
    neck.quaternion.identity(); // el clip lo pisa si lo anima; si no, queda en reposo
    mixer.update(dt);
    neck.quaternion.multiply(lookOffset.setFromEuler(_e.set(0, lookYaw, 0)));
  }

  // Flota, y da dos saltitos cuando hay aviso
  let y = Math.sin(t * 1.3) * 0.012;
  if (hopLeft > 0) {
    y += Math.abs(Math.sin((1 - hopLeft) * 2 * Math.PI)) * 0.09;
    hopLeft = Math.max(0, hopLeft - dt);
  }
  vrm.scene.position.y = y;
  // al caminar se pone de perfil hacia donde va; quieta, de frente
  vrm.scene.rotation.y += (baseYaw + mood.walking * Math.PI / 2 - vrm.scene.rotation.y) * (1 - Math.exp(-6 * dt));

  // Alas
  for (const w of wings) w.rotation.y = w.userData.side * (0.35 + Math.sin(flapPhase) * 0.4);

  vrm.update(dt); // huesos, mirada, expresiones y física del pelo
}
