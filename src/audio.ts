/** Jednoduchý syntetický zvuk motora (Web Audio). Spustí sa až po prvom stlačení klávesy/tlačidla. */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private o1!: OscillatorNode;
  private o2!: OscillatorNode;
  private o3!: OscillatorNode;
  private gain!: GainNode;
  private filter!: BiquadFilterNode;
  private noise!: GainNode;
  enabled = true;

  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 900;
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
      this.o2 = ctx.createOscillator(); this.o2.type = 'square';
      this.o3 = ctx.createOscillator(); this.o3.type = 'sawtooth';
      const mix = ctx.createGain(); mix.gain.value = 0.33;
      this.o1.connect(mix); this.o2.connect(mix); this.o3.connect(mix);
      mix.connect(this.filter); this.filter.connect(this.gain); this.gain.connect(ctx.destination);
      // šum vetra / pneumatík
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 700;
      this.noise = ctx.createGain(); this.noise.gain.value = 0;
      src.connect(nf); nf.connect(this.noise); this.noise.connect(ctx.destination);
      this.o1.start(); this.o2.start(); this.o3.start(); src.start();
    } catch { this.ctx = null; }
  }

  update(rpm: number, redline: number, throttle: number, speed: number, skid: number, volume: number, active: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const on = this.enabled && active;
    const x = Math.min(1.1, rpm / redline);
    const f = 38 + x * 150; // základná frekvencia
    this.o1.frequency.setTargetAtTime(f, now, 0.03);
    this.o2.frequency.setTargetAtTime(f * 0.5, now, 0.03);
    this.o3.frequency.setTargetAtTime(f * 2.01, now, 0.03);
    this.filter.frequency.setTargetAtTime(500 + x * 1800 + throttle * 900, now, 0.05);
    const g = on ? volume * (0.12 + 0.2 * throttle + 0.1 * x) : 0;
    this.gain.gain.setTargetAtTime(g, now, 0.06);
    const n = on ? volume * (Math.min(1, speed / 80) * 0.06 + skid * 0.12) : 0;
    this.noise.gain.setTargetAtTime(n, now, 0.08);
  }

  silence(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, now, 0.05);
    this.noise.gain.setTargetAtTime(0, now, 0.05);
  }
}
