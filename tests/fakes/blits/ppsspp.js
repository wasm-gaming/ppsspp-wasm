// Renders into a framebuffer of its own and then *blits it to the canvas* — the one
// thing none of the other fakes does, and the reason two of the runner's counters were
// unfalsifiable for six rounds.
//
// `drawsToCanvas` and `clearsToCanvas` count draws and clears issued while the default
// framebuffer is bound. Every other fake here either paints with scissored clears (no
// draw call at all) or never leaves its own FBO, so both counters could have been
// hard-wired to zero and all six cases would still have passed. A predicate that never
// fires and a fake that never triggers it agree with each other, and that agreement is
// what let a wrong number survive rounds 18 through 23.
//
// So this one issues a real `drawArrays` with the default framebuffer bound, and binds
// it the way PPSSPP's `fbo_unbind()` does — `bindFramebuffer(FRAMEBUFFER, null)`, which
// Emscripten's own glBindFramebuffer forwards as `undefined` for a zero name. The
// selftest pins both the count and the shape.
const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision mediump float;
uniform vec3 tint;
out vec4 colour;
void main() { colour = vec4(tint, 1.0); }`;

export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into before callMain. A fake without one would make the harness throw
    // where the emulator would not.
    ENV: {},
    callMain() {
      const gl = moduleArg.canvas.getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');

      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const where = gl.getAttribLocation(program, 'pos');
      gl.enableVertexAttribArray(where);
      gl.vertexAttribPointer(where, 2, gl.FLOAT, false, 0, 0);
      const tint = gl.getUniformLocation(program, 'tint');

      // An offscreen target, so that the run has binds in both directions rather than
      // one that is trivially always the canvas.
      const fbo = gl.createFramebuffer();
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

      let frame = 0;
      const draw = () => {
        frame++;
        // Somewhere nobody sees, first.
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, 64, 64);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // And then onto the canvas, which is the part that has to be counted.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0.05, 0.05, 0.07, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        for (let i = 0; i < 4; i++) {
          const x = -1 + i * 0.5 + ((frame % 60) / 60) * 0.1;
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x, -0.8, x + 0.4, -0.8, x, 0.8, x + 0.4, 0.8]), gl.STREAM_DRAW);
          gl.uniform3f(tint, ((i * 61 + frame) % 256) / 255, ((i * 37) % 256) / 255, ((i * 113 + frame * 2) % 256) / 255);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
  });
}
