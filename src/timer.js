// libdatachannel paces video in 2 ms ticks and caps each tick's budget, but default
// Windows timers fire every ~15.6 ms, which starves the video track. Ask Windows for
// 1 ms timer resolution for this process.
export async function raiseTimerResolution() {
  if (process.platform !== 'win32') return;
  try {
    const { default: koffi } = await import('koffi');
    const timeBeginPeriod = koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32)');
    if (timeBeginPeriod(1) !== 0) console.warn('timeBeginPeriod(1) was refused; video may stutter');
  } catch (error) {
    console.warn(`Could not raise timer resolution (${error.message}); video may stutter`);
  }
}
