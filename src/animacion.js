// Clips de animación para el VRM: .vrma (VRM Animation) y .fbx de Mixamo adaptados al esqueleto VRM.
// El adaptador de Mixamo sigue el ejemplo oficial de three-vrm (loadMixamoAnimation).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationHumanoidTracks } from '@pixiv/three-vrm-animation';

// Huesos de Mixamo → huesos humanoides de VRM
const MIXAMO_A_VRM = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

// FBX de Mixamo → clip para los huesos normalizados del VRM.
// `alturaCaderas`: altura de las caderas del VRM en reposo, para escalar el desplazamiento.
export function clipDesdeFBX(buffer, vrm, alturaCaderas) {
  const asset = new FBXLoader().parse(buffer, '');
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  if (!clip) throw new Error('el FBX no trae animación');
  const tracks = [];
  const restInversa = new THREE.Quaternion();
  const restPadre = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const caderas = asset.getObjectByName('mixamorigHips');
  const escala = caderas ? alturaCaderas / caderas.position.y : 1;
  const vrm0 = vrm.meta?.metaVersion === '0';

  for (const track of clip.tracks) {
    const [hueso, propiedad] = track.name.split('.');
    const nodo = vrm.humanoid.getNormalizedBoneNode(MIXAMO_A_VRM[hueso]);
    const origen = asset.getObjectByName(hueso);
    if (!nodo || !origen) continue;
    // se pasa la rotación del espacio del esqueleto de Mixamo (con su pose de reposo) al del VRM
    origen.getWorldQuaternion(restInversa).invert();
    origen.parent.getWorldQuaternion(restPadre);
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const valores = track.values.slice();
      for (let i = 0; i < valores.length; i += 4) {
        q.fromArray(valores, i).premultiply(restPadre).multiply(restInversa).toArray(valores, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${nodo.name}.${propiedad}`, track.times,
        valores.map((v, i) => (vrm0 && i % 2 === 0 ? -v : v))));
    } else if (track instanceof THREE.VectorKeyframeTrack && propiedad === 'position') {
      tracks.push(new THREE.VectorKeyframeTrack(`${nodo.name}.${propiedad}`, track.times,
        track.values.map((v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * escala)));
    }
  }
  return new THREE.AnimationClip('mixamo', clip.duration, tracks);
}

// .vrma → clip solo con huesos: sin expresiones ni mirada, que las sigue llevando el código
export async function clipDesdeVRMA(buffer, vrm) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer, '');
  const animacion = gltf.userData.vrmAnimations?.[0];
  if (!animacion) throw new Error('el .vrma no trae animación');
  const { translation, rotation } = createVRMAnimationHumanoidTracks(animacion, vrm.humanoid, vrm.meta?.metaVersion ?? '1');
  return new THREE.AnimationClip('vrma', animacion.duration, [...translation.values(), ...rotation.values()]);
}

// Deja el clip "en el sitio": quita el avance horizontal de las caderas (x, z) y conserva el sube y baja.
// Sirve para caminar aunque el FBX se haya bajado sin «In Place»; el desplazamiento lo hace la ventana.
export function enSitio(clip, vrm) {
  const nombre = `${vrm.humanoid.getNormalizedBoneNode('hips').name}.position`;
  const track = clip.tracks.find((t) => t.name === nombre);
  if (!track) return clip;
  const v = track.values;
  for (let i = 3; i < v.length; i += 3) {
    v[i] = v[0];
    v[i + 2] = v[2];
  }
  return clip;
}
