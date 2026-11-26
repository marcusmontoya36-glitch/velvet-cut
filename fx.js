// WebGL renderer for one video frame with the full camera look: crop/zoom, keystone (high/low angle),
// dutch tilt, fisheye and mirror. Used by the preview (fisheye + boomerang shots), the real-time export and
// the fast WebCodecs export (which also uses the colour / sharpen / blend / rotation options).
// Geometry matches render.js camCss / camFF / warpFF exactly.
import { camAt, warpQuad, squareToQuad, containRect, shadowBaseSize, SHADOW_PEAK } from './render.js';

const VS = `attribute vec2 a; varying vec2 v; void main(){ v = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `precision highp float;
#define SHPEAK ${SHADOW_PEAK.toFixed(3)}
varying vec2 v; uniform sampler2D t; uniform sampler2D t2;
uniform vec3 h0; uniform vec3 h1; uniform vec3 h2; uniform float useH;
uniform vec3 crop; uniform vec4 box; uniform float fish; uniform float aspect; uniform float flip;
uniform float rot; uniform float mixW; uniform float alpha; uniform float gain;
uniform vec3 col; uniform vec4 warm; uniform float sharp; uniform vec2 texel; uniform float useCol;
uniform sampler2D tb; uniform float shadow; uniform vec4 scr; // source crop: x0, y0, w, h (displayed orientation)
// shadow recovery: same formula as render.js shadowK / shadowFF
float shK(float Y, float B, float P) {
  float Q = sqrt(max(Y, 0.0));
  float a = smoothstep(0.04, 0.16, abs(Q - B));
  float M = mix(B, Q, a); M *= M;
  float w = 1.0 - smoothstep(0.3, 0.75, M);
  float fM = mix(M, pow(max(M, 0.0001), 1.0 - 0.6 * shadow), w);
  float kb = min(fM / max(M, 0.004), 1.0 + 3.0 * shadow);
  float k = clamp(kb * pow((Y + 0.02) / (M + 0.02), 0.25 * shadow * w), 0.5, 4.0);
  return min(k, max(1.0, SHPEAK / max(P, 0.001)));
}
vec2 rawUv(vec2 s) { // displayed orientation -> stored texture orientation (phone rotation metadata)
  if (rot < 0.5) return s;
  if (rot < 1.5) return vec2(s.y, 1.0 - s.x);
  if (rot < 2.5) return vec2(1.0 - s.x, 1.0 - s.y);
  return vec2(1.0 - s.y, s.x);
}
vec3 samp(vec2 s) {
  vec2 r = rawUv(scr.xy + s * scr.zw);
  vec3 c0 = texture2D(t, r).rgb, c = c0;
  if (mixW > 0.0) c = mix(c, texture2D(t2, r).rgb, mixW);
  vec3 n = vec3(0.0);
  if (sharp > 0.0 || shadow > 0.0)
    n = texture2D(t, r + vec2(texel.x, 0.0)).rgb + texture2D(t, r - vec2(texel.x, 0.0)).rgb
      + texture2D(t, r + vec2(0.0, texel.y)).rgb + texture2D(t, r - vec2(0.0, texel.y)).rgb;
  if (sharp > 0.0) c = c + sharp * (c * 4.0 - n);
  c = clamp(c, 0.0, 1.0);
  if (shadow > 0.0) {
    vec4 bb = texture2D(tb, r);
    float k = shK(dot(c0, vec3(0.2126, 0.7152, 0.0722)), bb.r + bb.g / 255.0, max(c0.r, max(c0.g, c0.b)));
    vec3 cd = mix(c, (c0 + n) / 5.0, clamp((k - 1.0) / 4.0, 0.0, 0.6));
    c = clamp(cd * k, 0.0, 1.0);
  }
  return c;
}
float sl(float b, float s) { // W3C soft-light
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
void main(){
  vec2 o = v;
  if (flip > 0.5) o.x = 1.0 - o.x;
  if (fish > 0.0) {
    vec2 sc = vec2(aspect, 1.0); vec2 d = (o - 0.5) * sc; vec2 hc = sc * 0.5;
    float r2 = dot(d, d) / dot(hc, hc);
    d *= (1.0 - fish + fish * r2); o = d / sc + 0.5;
  }
  vec2 c = o;
  if (useH > 0.5) { vec3 q = vec3(o, 1.0); c = vec2(dot(h0, q), dot(h1, q)) / dot(h2, q); }
  vec2 f = (c - 0.5) / crop.x + crop.yz;
  vec2 s = (f - box.xy) / box.zw;
  vec3 rgb = vec3(0.0);
  if (s.x >= 0.0 && s.y >= 0.0 && s.x <= 1.0 && s.y <= 1.0) rgb = samp(s);
  if (useCol > 0.5) { // same order as the CSS preview: brightness -> contrast -> saturate, then warm soft-light
    rgb = clamp(rgb * col.x, 0.0, 1.0);
    rgb = clamp((rgb - 0.5) * col.y + 0.5, 0.0, 1.0);
    float l = dot(rgb, vec3(0.213, 0.715, 0.072));
    rgb = clamp(l + col.z * (rgb - l), 0.0, 1.0);
    if (warm.a > 0.0) rgb = mix(rgb, vec3(sl(rgb.r, warm.r), sl(rgb.g, warm.g), sl(rgb.b, warm.b)), warm.a);
  }
  gl_FragColor = vec4(rgb * gain, alpha);
}`;

// shadow base: Q = sqrt(luma) area-averaged onto a small grid (pass A), then a 5×5 binomial blur (pass B).
// Values are packed into two 8-bit channels (hi + lo/255) so the base keeps ~16-bit precision in the darks.
const BVS = `attribute vec2 a; varying vec2 v; void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;
const PACK = `vec4 pack(float x) { x = clamp(x, 0.0, 1.0) * 255.0; float h = floor(x); return vec4(h / 255.0, x - h, 0.0, 1.0); }
float unpack(vec4 p) { return p.r + p.g / 255.0; }`;
const FSA = `precision highp float; varying vec2 v; uniform sampler2D t; uniform vec2 cell; ${PACK}
void main() { float s = 0.0;
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) / 8.0 - 0.5;
    s += sqrt(max(dot(texture2D(t, v + o * cell).rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0));
  }
  gl_FragColor = pack(s / 64.0); }`;
const FSB = `precision highp float; varying vec2 v; uniform sampler2D t; uniform vec2 cell; ${PACK}
void main() { float s = 0.0; float wt[5]; wt[0] = 1.0; wt[1] = 4.0; wt[2] = 6.0; wt[3] = 4.0; wt[4] = 1.0;
  for (int i = 0; i < 5; i++) for (int j = 0; j < 5; j++)
    s += wt[i] * wt[j] * unpack(texture2D(t, v + vec2(float(i) - 2.0, float(j) - 2.0) * cell));
  gl_FragColor = pack(s / 256.0); }`;

export function createFx(canvas, ctxOpts = {}) {
  const attrs = { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false, alpha: false, ...ctxOpts };
  const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.bindAttribLocation(pr, 0, 'a'); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const al = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
  const mkTex = (unit) => {
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
    [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach(([k, val]) => gl.texParameteri(gl.TEXTURE_2D, k, val));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  };
  const tex = mkTex(0), tex2 = mkTex(1);
  const U = {}; ['t', 't2', 'tb', 'shadow', 'h0', 'h1', 'h2', 'useH', 'crop', 'box', 'fish', 'aspect', 'flip', 'rot', 'mixW', 'alpha', 'gain', 'col', 'warm', 'sharp', 'texel', 'useCol', 'scr'].forEach(n => U[n] = gl.getUniformLocation(pr, n));
  gl.uniform1i(U.t, 0); gl.uniform1i(U.t2, 1); gl.uniform1i(U.tb, 2);
  // ---- shadow base passes (lazy) ----
  let SB = null;
  const shadowBase = (rw, rh) => {
    const [bw, bh] = shadowBaseSize(rw, rh);
    if (!SB) {
      const mk = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, BVS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p); return p; };
      SB = { pA: mk(FSA), pB: mk(FSB), w: 0, h: 0 };
    }
    if (SB.w !== bw || SB.h !== bh) {
      for (const k of ['tA', 'tB']) { if (SB[k]) gl.deleteTexture(SB[k]); }
      for (const k of ['fA', 'fB']) { if (SB[k]) gl.deleteFramebuffer(SB[k]); }
      const mkT = (unit, filt) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, filt], [gl.TEXTURE_MAG_FILTER, filt]].forEach(([k, val]) => gl.texParameteri(gl.TEXTURE_2D, k, val));
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return t; };
      const mkF = (t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      SB.tA = mkT(3, gl.NEAREST); SB.fA = mkF(SB.tA); SB.tB = mkT(2, gl.LINEAR); SB.fB = mkF(SB.tB);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      SB.w = bw; SB.h = bh;
    }
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.disable(gl.BLEND); gl.viewport(0, 0, bw, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, SB.fA); gl.useProgram(SB.pA);
    gl.uniform1i(gl.getUniformLocation(SB.pA, 't'), 0); gl.uniform2f(gl.getUniformLocation(SB.pA, 'cell'), 1 / bw, 1 / bh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, SB.fB); gl.useProgram(SB.pB);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, SB.tA);
    gl.uniform1i(gl.getUniformLocation(SB.pB, 't'), 3); gl.uniform2f(gl.getUniformLocation(SB.pB, 'cell'), 1 / bw, 1 / bh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, SB.tB);
  };
  const upload = (unit, t, src) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); };
  function clear() { gl.useProgram(pr); const W = canvas.width, H = canvas.height; gl.viewport(0, 0, W, H); gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  /**
   * draw src (video / canvas / ImageBitmap / VideoFrame, displayed size sw×sh) with cam at progress p.
   * o (optional): { layer: true (blend over what's there instead of replacing), alpha, gain, src2 + mix (frame blend),
   *   color: {b,c,s}, warm: [r,g,b,a], sharp, rot (0..3 quarter turns of the stored frame), shadow (0..1 lift), crop: [x0,y0,x1,y1] source crop }
   */
  function draw(src, sw, sh, cam, p, o = {}) {
    const W = canvas.width, H = canvas.height;
    if (!sw || !sh) return false;
    gl.useProgram(pr);
    gl.viewport(0, 0, W, H);
    try { upload(0, tex, src); if (o.src2 && o.mix > 0) upload(1, tex2, o.src2); } catch { return false; }
    const shd = Math.max(0, Math.min(1, o.shadow || 0));
    if (shd > 0) {
      const rw0 = (o.rot || 0) % 2 ? sh : sw, rh0 = (o.rot || 0) % 2 ? sw : sh;
      try { shadowBase(rw0, rh0); } catch (e) { console.warn('shadow base failed', e); }
      gl.useProgram(pr); gl.viewport(0, 0, W, H);
    }
    gl.uniform1f(U.shadow, shd > 0 && SB ? shd : 0);
    const { z, cx, cy } = camAt(cam || null, p);
    // o.crop = [x0, y0, x1, y1] of the displayed source (the clip's crop): only that part is shown, fitted to the frame
    const sc = o.crop && o.crop.length === 4 ? o.crop : [0, 0, 1, 1];
    gl.uniform4f(U.scr, sc[0], sc[1], sc[2] - sc[0], sc[3] - sc[1]);
    const [dx, dy, dw, dh] = containRect(sw * (sc[2] - sc[0]), sh * (sc[3] - sc[1]), W, H);
    gl.uniform3f(U.crop, z, cx, cy);
    gl.uniform4f(U.box, dx / W, dy / H, dw / W, dh / H);
    gl.uniform1f(U.aspect, W / H);
    gl.uniform1f(U.flip, cam?.flip ? 1 : 0);
    gl.uniform1f(U.fish, cam?.fish > 0.005 ? Math.min(0.45, cam.fish) : 0);
    const q = warpQuad(cam, W / H);
    if (q) { const m = squareToQuad(q); gl.uniform3f(U.h0, m[0], m[1], m[2]); gl.uniform3f(U.h1, m[3], m[4], m[5]); gl.uniform3f(U.h2, m[6], m[7], m[8]); gl.uniform1f(U.useH, 1); }
    else gl.uniform1f(U.useH, 0);
    gl.uniform1f(U.rot, o.rot || 0);
    gl.uniform1f(U.mixW, o.src2 && o.mix > 0 ? Math.min(1, o.mix) : 0);
    gl.uniform1f(U.alpha, o.alpha ?? 1);
    gl.uniform1f(U.gain, o.gain ?? 1);
    const cl = o.color;
    gl.uniform1f(U.useCol, cl || o.warm ? 1 : 0);
    gl.uniform3f(U.col, cl ? 1 + cl.b : 1, cl ? cl.c : 1, cl ? cl.s : 1);
    const wm = o.warm || [0, 0, 0, 0]; gl.uniform4f(U.warm, wm[0], wm[1], wm[2], wm[3]);
    gl.uniform1f(U.sharp, o.sharp || 0);
    const rw = (o.rot || 0) % 2 ? sh : sw, rh = (o.rot || 0) % 2 ? sw : sh;
    gl.uniform2f(U.texel, 1 / rw, 1 / rh);
    if (o.layer) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
  return { draw, clear, gl, canvas };
}
