/**
 * Procedural sky: a shader sky dome (gradient, dawn/dusk band, sun disc,
 * moon, hash-noise star field) plus the scene's directional sun light and
 * hemisphere ambient. No textures — everything is computed in the shader.
 */
import * as THREE from 'three';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uDayness;
uniform float uTime;
varying vec3 vDir;

float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

void main() {
  vec3 dir = normalize(vDir);
  float elev = dir.y;
  float sunE = uSunDir.y;

  // base gradient: zenith -> horizon, day vs night
  float horiz = pow(clamp(1.0 - max(elev, 0.0), 0.0, 1.0), 2.2);
  vec3 dayZen = vec3(0.145, 0.32, 0.62);
  vec3 dayHor = vec3(0.62, 0.74, 0.88);
  vec3 nightZen = vec3(0.010, 0.016, 0.042);
  vec3 nightHor = vec3(0.042, 0.058, 0.105);
  vec3 sky = mix(mix(nightZen, nightHor, horiz), mix(dayZen, dayHor, horiz), uDayness);

  // warm dawn/dusk band concentrated near the sun's azimuth and the horizon
  float twilight = exp(-sunE * sunE * 18.0);
  vec2 dH = normalize(dir.xz + vec2(1e-4));
  vec2 sH = normalize(uSunDir.xz + vec2(1e-4));
  float azim = dot(dH, sH) * 0.5 + 0.5;
  float band = twilight * pow(azim, 3.0) * exp(-abs(elev) * 4.0);
  sky += vec3(0.98, 0.36, 0.12) * band * 0.85;

  // sun disc + glow (fades out below the horizon)
  float cs = dot(dir, uSunDir);
  float sunVis = smoothstep(-0.09, 0.03, sunE);
  float disc = smoothstep(0.99935, 0.99985, cs);
  float glow = pow(max(cs, 0.0), 160.0) * 0.45 + pow(max(cs, 0.0), 10.0) * 0.10;
  vec3 sunCol = mix(vec3(1.2, 0.45, 0.15), vec3(1.25, 1.15, 0.95), clamp(sunE * 2.5, 0.0, 1.0));
  sky += sunCol * (disc * 5.0 + glow) * sunVis;

  // moon disc + faint glow at night
  float night = 1.0 - uDayness;
  float cm = dot(dir, uMoonDir);
  float mdisc = smoothstep(0.99950, 0.99985, cm);
  float mglow = pow(max(cm, 0.0), 80.0) * 0.10;
  sky += vec3(0.65, 0.72, 0.90) * (mdisc * 1.4 + mglow) * night;

  // star field via hash noise, visible at night above the horizon
  if (night > 0.02 && elev > 0.0) {
    vec3 sp = dir * 190.0;
    vec3 cell = floor(sp);
    float rnd = hash31(cell);
    if (rnd > 0.994) {
      vec3 f = sp - cell;
      vec3 cpos = vec3(hash31(cell + 17.1), hash31(cell + 31.7), hash31(cell + 47.3)) * 0.6 + 0.2;
      float d = length(f - cpos);
      float mag = (rnd - 0.994) / 0.006;
      float tw = 0.7 + 0.3 * sin(uTime * (1.5 + mag * 3.0) + rnd * 80.0);
      float star = smoothstep(0.32, 0.0, d) * mag * tw;
      sky += vec3(0.9, 0.95, 1.1) * star * night * smoothstep(0.0, 0.12, elev);
    }
  }

  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DAY_HEMI_SKY = new THREE.Color(0xb8d0ee);
const NIGHT_HEMI_SKY = new THREE.Color(0x16213f);
const DAY_HEMI_GROUND = new THREE.Color(0x6b6350);
const NIGHT_HEMI_GROUND = new THREE.Color(0x0d0f14);
const DAY_FOG = new THREE.Color(0xc7d6e8);
const NIGHT_FOG = new THREE.Color(0x0a0f1c);
const WARM_FOG = new THREE.Color(0xd98a4e);
const SUN_DAWN = new THREE.Color(1.0, 0.55, 0.25);
const SUN_NOON = new THREE.Color(1.0, 0.97, 0.92);
const MOON_BLUE = new THREE.Color(0x92a7d8);

/**
 * Owns the sky dome, the shadow-casting directional light (sun by day, a dim
 * moon-blue light by night) and the hemisphere ambient. `update()` positions
 * everything from the sim's sun angle; the returned `sunDir` points FROM the
 * scene TOWARD the sun (y < 0 at night) and is a reused vector — copy it if
 * you need to keep it.
 */
export class SkyRig {
  /** Shadow-casting directional light (sun by day, moon-blue at night). */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere ambient, tinted by time of day. */
  readonly hemi: THREE.HemisphereLight;
  /** Fog tint for the current time of day; updated by `update()`. */
  readonly fogColor = new THREE.Color(0xc7d6e8);
  /**
   * Point the shadow camera follows (copy the camera/orbit target in before
   * calling `update()` so the 2048 shadow map stays centered on the view).
   */
  readonly focus = new THREE.Vector3();

  private readonly scene: THREE.Scene;
  private readonly dome: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly moonDir = new THREE.Vector3(0, 1, 0);
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private readonly result = { sunDir: this.sunDir, dayness: 1 };

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    const geo = new THREE.SphereGeometry(1000, 48, 24);
    const mat = new THREE.ShaderMaterial({
      name: 'GenesisSky',
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uDayness: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.uniforms = mat.uniforms;
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.name = 'sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -48;
    sc.right = 48;
    sc.top = 48;
    sc.bottom = -48;
    sc.near = 20;
    sc.far = 360;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(DAY_HEMI_SKY, DAY_HEMI_GROUND, 0.9);
    scene.add(this.hemi);
  }

  /** Star-twinkle clock (sim time, seconds). */
  setTime(time: number): void {
    this.uniforms['uTime'].value = time;
  }

  /**
   * Reposition sun/moon and retint all lighting from the sun angle
   * (elevation = sin(sunAngle)) and season phase (0..1, tilts the sun path).
   */
  update(sunAngle: number, seasonPhase: number): { sunDir: THREE.Vector3; dayness: number } {
    const tilt = 0.42 + 0.18 * Math.sin(seasonPhase * Math.PI * 2);
    this.sunDir.set(Math.cos(sunAngle), Math.sin(sunAngle), tilt).normalize();
    const e = this.sunDir.y;
    const dayness = THREE.MathUtils.smoothstep(e, -0.06, 0.18);
    const twilight = Math.exp(-e * e * 18);
    this.moonDir.set(-this.sunDir.x, Math.max(0.3, -e), -this.sunDir.z).normalize();

    (this.uniforms['uSunDir'].value as THREE.Vector3).copy(this.sunDir);
    (this.uniforms['uMoonDir'].value as THREE.Vector3).copy(this.moonDir);
    this.uniforms['uDayness'].value = dayness;

    // one shadow light: sun by day, dim moon-blue at night (no popping: both
    // branches approach zero intensity at the handover elevation)
    if (e > -0.04) {
      this.lightDir.copy(this.sunDir);
      this.sun.color.lerpColors(SUN_DAWN, SUN_NOON, THREE.MathUtils.clamp(e * 2.5, 0, 1));
      this.sun.intensity = 3.0 * THREE.MathUtils.smoothstep(e, -0.02, 0.28);
    } else {
      this.lightDir.copy(this.moonDir);
      this.sun.color.copy(MOON_BLUE);
      this.sun.intensity = 0.14 * THREE.MathUtils.smoothstep(-e, 0.02, 0.25);
    }
    this.sun.position.copy(this.focus).addScaledVector(this.lightDir, 150);
    this.sun.target.position.copy(this.focus);
    this.sun.target.updateMatrixWorld();

    this.hemi.color.lerpColors(NIGHT_HEMI_SKY, DAY_HEMI_SKY, dayness);
    this.hemi.groundColor.lerpColors(NIGHT_HEMI_GROUND, DAY_HEMI_GROUND, dayness);
    this.hemi.intensity = 0.18 + 0.72 * dayness;

    this.fogColor.lerpColors(NIGHT_FOG, DAY_FOG, dayness);
    this.fogColor.lerp(WARM_FOG, twilight * 0.45);

    this.result.dayness = dayness;
    return this.result;
  }

  /** Remove everything from the scene and free GPU resources. */
  dispose(): void {
    this.scene.remove(this.dome, this.sun, this.sun.target, this.hemi);
    this.dome.geometry.dispose();
    (this.dome.material as THREE.ShaderMaterial).dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}
