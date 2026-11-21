// WebGL renderer for one video frame with the full camera look: crop/zoom, keystone (high/low angle),
// dutch tilt, fisheye and mirror. Used by the preview (fisheye + boomerang shots) and the real-time export.
// Geometry matches render.js camCss / camFF / warpFF exactly.
import { camAt, warpQuad, squareToQuad, containRect } from './render.js';

const VS = `attribute vec2 a; varying vec2 v; void main(){ v = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `precision highp float;
varying vec2 v; uniform sampler2D t;
uniform vec3 h0; uniform vec3 h1; uniform vec3 h2; uniform float useH;
uniform vec3 crop; uniform vec4 box; uniform float fish; uniform float aspect; uniform float flip;
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
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  else gl_FragColor = texture2D(t, s);
}`;

export function createFx(canvas) {
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false })
    || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const al = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach(([k, val]) => gl.texParameteri(gl.TEXTURE_2D, k, val));
  const U = {}; ['h0', 'h1', 'h2', 'useH', 'crop', 'box', 'fish', 'aspect', 'flip'].forEach(n => U[n] = gl.getUniformLocation(pr, n));
  /** draw src (video / canvas / ImageBitmap, natural size sw×sh) with cam at progress p into the canvas */
  function draw(src, sw, sh, cam, p) {
    const W = canvas.width, H = canvas.height;
    if (!sw || !sh) return false;
    gl.viewport(0, 0, W, H);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return false; }
    const { z, cx, cy } = camAt(cam || null, p);
    const [dx, dy, dw, dh] = containRect(sw, sh, W, H);
    gl.uniform3f(U.crop, z, cx, cy);
    gl.uniform4f(U.box, dx / W, dy / H, dw / W, dh / H);
    gl.uniform1f(U.aspect, W / H);
    gl.uniform1f(U.flip, cam?.flip ? 1 : 0);
    gl.uniform1f(U.fish, cam?.fish > 0.005 ? Math.min(0.45, cam.fish) : 0);
    const q = warpQuad(cam, W / H);
    if (q) { const m = squareToQuad(q); gl.uniform3f(U.h0, m[0], m[1], m[2]); gl.uniform3f(U.h1, m[3], m[4], m[5]); gl.uniform3f(U.h2, m[6], m[7], m[8]); gl.uniform1f(U.useH, 1); }
    else gl.uniform1f(U.useH, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
  return { draw, gl, canvas };
}
