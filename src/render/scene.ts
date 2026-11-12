import * as THREE from 'three';
import type { Racer } from '../sim/race';
import type { Sim } from '../sim/sim';
import { buildTrack, type TrackView } from './trackMesh';
import { buildCar, updateCar, type CarView } from './carModel';
import { clamp, lerp, wrapPi } from '../sim/math';

export type CameraMode = 'chase' | 'cockpit';

const SKY_CLEAR = new THREE.Color(0x8ec5ff);
const SKY_RAIN = new THREE.Color(0x6d7682);
const FOG_CLEAR = new THREE.Color(0xc4dcf2);
const FOG_RAIN = new THREE.Color(0x7d858f);

/** 3D pohľad na preteky (Three.js). Simulácia je od renderu oddelená – render iba číta stav. */
export class RaceView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  cameraMode: CameraMode = 'chase';
  private track!: TrackView;
  private cars = new Map<Racer, CarView>();
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camYaw = 0;
  private lastPos = new Map<Racer, { x: number; y: number }>();
  private sky: THREE.Mesh;
  private wetLook = 0;

  constructor(private canvas: HTMLCanvasElement, private race: Sim) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 6000);
    this.scene.background = SKY_CLEAR.clone();
    this.scene.fog = new THREE.Fog(FOG_CLEAR.clone(), 250, 2400);

    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x4a6a3a, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    // obloha (jednoduchá kupola s gradientom)
    const skyGeo = new THREE.SphereGeometry(5000, 24, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d7fd6) }, bottom: { value: new THREE.Color(0xd8e8f5) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y*1.6, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);

    this.track = buildTrack(race.track, this.scene, { world: !!race.free });
    for (const r of race.racers) {
      const v = buildCar(r);
      this.scene.add(v.group);
      this.cars.set(r, v);
    }

    // dážď: krátke čiary okolo kamery
    const N = 2400;
    this.rainPos = new Float32Array(N * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false;
    for (let i = 0; i < N; i++) this.seedDrop(i, true);
    this.scene.add(this.rain);
    this.resize();
  }

  private seedDrop(i: number, any: boolean): void {
    const p = this.rainPos;
    const x = (Math.random() - 0.5) * 80, z = (Math.random() - 0.5) * 80;
    const y = any ? Math.random() * 30 : 28 + Math.random() * 4;
    p.set([x, y, z, x + 0.05, y - 0.7, z], i * 6);
  }

  resize(): void {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  toggleCamera(): CameraMode {
    this.cameraMode = this.cameraMode === 'chase' ? 'cockpit' : 'chase';
    this.snap = true;
    return this.cameraMode;
  }
  private snap = true;

  render(dt: number, focus: Racer): void {
    const race = this.race;
    // --- autá
    for (const [r, v] of this.cars) {
      v.group.visible = !r.hidden;
      if (r.hidden) continue;
      const st = r.st;
      const h = race.track.height(r.q.s);
      v.group.position.set(st.x, h, -st.y);
      // náklon podľa zrýchlenia (len vizuálne)
      v.group.rotation.set(clamp(st.ay / 9.81, -3, 3) * 0.012, st.heading, clamp(-st.ax / 9.81, -4, 4) * 0.008, 'YXZ');
      const lp = this.lastPos.get(r);
      const dd = lp ? Math.hypot(st.x - lp.x, st.y - lp.y) * Math.sign(st.vx || 1) : 0;
      this.lastPos.set(r, { x: st.x, y: st.y });
      updateCar(v, r, dd);
      v.cockpit.visible = !(r === focus && this.cameraMode === 'cockpit');
    }

    // --- svetlá na bráne
    const lit = race.phase === 'lights' ? race.lights : 0;
    this.track.lights.forEach((m, i) => m.color.setHex(i < lit ? 0xff1a1a : 0x220404));
    const green = race.phase === 'racing' && race.time < 3;
    this.track.greens.forEach((m) => m.color.setHex(green ? 0x22ff55 : 0x042204));

    // --- počasie
    const w = race.weather;
    this.wetLook = lerp(this.wetLook, w.wetness, Math.min(1, dt * 0.5));
    const cloud = w.cloud;
    (this.scene.background as THREE.Color).copy(SKY_CLEAR).lerp(SKY_RAIN, cloud * 0.9);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(FOG_CLEAR).lerp(FOG_RAIN, cloud * 0.9);
    fog.far = lerp(2400, 650, w.rain);
    fog.near = lerp(250, 60, w.rain);
    const sm = this.sky.material as THREE.ShaderMaterial;
    (sm.uniforms.top.value as THREE.Color).setHex(0x3d7fd6).lerp(new THREE.Color(0x59616d), cloud);
    (sm.uniforms.bottom.value as THREE.Color).setHex(0xd8e8f5).lerp(new THREE.Color(0x8a919a), cloud);
    this.sun.intensity = lerp(2.4, 0.45, cloud);
    this.hemi.intensity = lerp(0.9, 1.1, cloud);
    this.track.asphalt.roughness = lerp(0.92, 0.25, this.wetLook);
    this.track.asphalt.metalness = lerp(0, 0.35, this.wetLook);
    this.track.asphalt.color.setScalar(lerp(1, 0.62, this.wetLook));

    // --- kamera
    this.updateCamera(dt, focus);

    // tieň sleduje kameru
    const fp = new THREE.Vector3(focus.st.x, 0, -focus.st.y);
    this.sun.position.set(fp.x + 120, 220, fp.z + 80);
    this.sun.target.position.copy(fp);

    // dážď okolo kamery
    const rainOn = w.rain > 0.03;
    this.rain.visible = rainOn;
    if (rainOn) {
      const N = this.rainPos.length / 6;
      const active = Math.floor(N * clamp(w.rain, 0, 1));
      const fall = 26 * dt;
      const p = this.rainPos;
      for (let i = 0; i < N; i++) {
        if (i >= active) { p[i * 6 + 1] = -100; p[i * 6 + 4] = -100; continue; }
        p[i * 6 + 1] -= fall; p[i * 6 + 4] -= fall;
        if (p[i * 6 + 1] < 0) this.seedDrop(i, false);
      }
      this.rain.position.set(this.camera.position.x, this.camera.position.y - 12, this.camera.position.z);
      this.rain.geometry.attributes.position.needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.35 * w.rain;
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(dt: number, r: Racer): void {
    const st = r.st;
    const v = this.cars.get(r)!;
    const h = this.race.track.height(r.q.s);
    const car = new THREE.Vector3(st.x, h, -st.y);
    if (this.cameraMode === 'cockpit') {
      const c = Math.cos(st.heading), s = Math.sin(st.heading);
      const eye = new THREE.Vector3(st.x + c * v.eyeForward, h + v.eyeHeight, -(st.y + s * v.eyeForward));
      this.camera.position.copy(eye);
      const look = new THREE.Vector3(st.x + c * 30, h + v.eyeHeight - 0.4, -(st.y + s * 30));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(look);
      this.camera.rotateZ(clamp(st.ay / 9.81, -3, 3) * -0.01);
      this.camera.fov = 72;
      this.camera.updateProjectionMatrix();
      this.snap = true;
      return;
    }
    // stíhacia kamera: sleduje smer pohybu s oneskorením
    const spd = Math.hypot(st.vx, st.vy);
    const moveH = spd > 3 ? st.heading + Math.atan2(st.vy, Math.max(st.vx, 0.1)) * 0.5 : st.heading;
    if (this.snap) { this.camYaw = moveH; }
    this.camYaw += wrapPi(moveH - this.camYaw) * Math.min(1, dt * 5);
    const dist = 7.6 + Math.min(spd, 80) * 0.025;
    const height = 2.6;
    const c = Math.cos(this.camYaw), s = Math.sin(this.camYaw);
    const target = new THREE.Vector3(st.x - c * dist, h + height, -(st.y - s * dist));
    const look = car.clone().add(new THREE.Vector3(c * 3, 1.0, -s * 3));
    if (this.snap) { this.camPos.copy(target); this.camLook.copy(look); this.snap = false; }
    this.camPos.lerp(target, Math.min(1, dt * 9));
    this.camLook.lerp(look, Math.min(1, dt * 14));
    this.camera.position.copy(this.camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    this.camera.fov = 60 + Math.min(spd, 90) * 0.1;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.renderer.dispose();
  }
}
