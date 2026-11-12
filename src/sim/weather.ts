import { clamp, lerp, mulberry32 } from './math';

export type WeatherMode = 'dry' | 'dynamic' | 'rain';
export type WeatherLabel = 'clear' | 'cloudy' | 'lightrain' | 'rainy' | 'heavyrain';

/**
 * Počasie s postupnými zmenami: intenzita dažďa sa plynulo približuje k cieľu,
 * trať vlhne počas dažďa a pomaly schne, keď prestane pršať.
 */
export class Weather {
  rain = 0; // 0..1 aktuálna intenzita
  target = 0;
  wetness = 0; // 0..1 vlhkosť trate
  cloud = 0.2;
  private nextChange = 0;
  private rnd: () => number;
  private time = 0;

  constructor(readonly mode: WeatherMode, seed = 1, readonly timeScale = 1) {
    this.rnd = mulberry32(seed);
    if (mode === 'rain') { this.rain = this.target = 0.55 + 0.25 * this.rnd(); this.wetness = 0.85; this.cloud = 0.95; }
    if (mode === 'dynamic') {
      this.rain = this.target = this.rnd() < 0.3 ? 0.3 : 0;
      this.wetness = this.rain > 0 ? 0.4 : 0;
      this.nextChange = 25 + this.rnd() * 40;
    }
  }

  update(dt: number): void {
    const sdt = dt * this.timeScale;
    this.time += sdt;
    if (this.mode === 'dynamic' && this.time > this.nextChange) {
      const r = this.rnd();
      if (this.target < 0.05) this.target = r < 0.55 ? 0.25 + 0.6 * this.rnd() : 0;
      else this.target = r < 0.45 ? 0 : clamp(this.target + (this.rnd() - 0.5) * 0.6, 0.15, 1);
      this.nextChange = this.time + 45 + this.rnd() * 75;
    }
    // prirodzené tempo: zmena intenzity ~ 1/40 s
    const rate = 0.025;
    this.rain += clamp(this.target - this.rain, -rate * sdt, rate * sdt);
    if (this.rain < 0.002) this.rain = 0;
    // vlhkosť trate: rýchlo vlhne, pomaly schne
    const wetTarget = clamp(this.rain * 1.2, 0, 1);
    if (wetTarget > this.wetness) this.wetness = Math.min(wetTarget, this.wetness + (0.015 + 0.04 * this.rain) * sdt);
    else this.wetness = Math.max(wetTarget, this.wetness - 0.0045 * sdt);
    this.cloud = lerp(this.cloud, clamp(0.25 + this.target * 1.2, 0, 1), 0.02 * sdt);
  }

  /** Priľnavosť asfaltu (1 = sucho). */
  get grip(): number {
    return 1 - 0.32 * this.wetness - 0.06 * this.rain;
  }

  get label(): WeatherLabel {
    if (this.rain > 0.7) return 'heavyrain';
    if (this.rain > 0.35) return 'rainy';
    if (this.rain > 0.05) return 'lightrain';
    return this.cloud > 0.55 ? 'cloudy' : 'clear';
  }
}
