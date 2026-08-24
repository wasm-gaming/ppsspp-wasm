// Draws a picture the browser shows and a compositing host cannot see.
//
// This is round 26's fingerprint, reproduced without an emulator: a default WebGL2
// context — `alpha: true`, `premultipliedAlpha: true`, which is what Emscripten and
// SDL3 ask for — filled with colour whose alpha is left at zero. The browser composites
// the drawing buffer as premultiplied, so `dst = src.rgb + dst.rgb * (1 - 0)`: the
// colour is *added* to the page and a screenshot has a picture in it. Anything that
// draws the same canvas into a transparent target gets `src.rgb + 0` at alpha 0, and
// `getImageData` un-premultiplies that back to nothing.
//
// So the two readings disagree by exactly the amount the port's own canvas does, and
// the runner has to say which of them is the instrument's fault. It is neither: it is
// the alpha channel.
export default async function createPpsspp(moduleArg = {}) {
  const module = Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into. A fake without one would make the harness throw where the
    // emulator would not.
    ENV: {},
    // Modelled on the real bridge rather than stubbed: 1 for a setting PPSSPP has, 0
    // for one it does not. The runner asks all three on every run, and a fake that
    // always said 1 would let a harness bug through.
    ccall(name, _returnType, _argTypes, args) {
      if (name !== 'ppsspp_web_apply_setting') return 0;
      return /^(General|CPU|Graphics|Sound|Control|SystemParam|Web)\//.test(args[0]) ? 1 : 0;
    },
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
          // The one difference from `draws/`, and the whole of the case: alpha 0.
          gl.clearColor(((i * 31 + frame) % 256) / 255, ((i * 71) % 256) / 255, ((i * 17 + frame * 3) % 256) / 255, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.disable(gl.SCISSOR_TEST);
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
  });
  // Emscripten calls these before the static constructors that copy ENV into the
  // environment C sees, and hands each one the module. That is where the runner writes
  // SDL3's canvas selector, so a fake that never called them would leave the one path
  // the real build depends on untested.
  for (const fn of moduleArg.preRun ?? []) fn(module);
  return module;
}
