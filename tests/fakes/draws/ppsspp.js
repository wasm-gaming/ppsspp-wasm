// Draws, and keeps changing what it draws: the DRAWING verdict has to be reachable.
//
// Eight scissored bands rather than a textured quad, because this has to prove the
// runner can see colour — not that WebGL under SwiftShader can compile a shader.
export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into before callMain. A fake without one would make the harness throw
    // where the emulator would not.
    ENV: {},
    callMain() {
      const gl = moduleArg.canvas.getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');
      let frame = 0;
      const draw = () => {
        frame++;
        const w = Math.floor(gl.drawingBufferWidth / 8);
        gl.enable(gl.SCISSOR_TEST);
        for (let i = 0; i < 8; i++) {
          gl.scissor(i * w, 0, w, gl.drawingBufferHeight);
          gl.clearColor(((i * 31 + frame) % 256) / 255, ((i * 71) % 256) / 255, ((i * 17 + frame * 3) % 256) / 255, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.disable(gl.SCISSOR_TEST);
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
  });
}
