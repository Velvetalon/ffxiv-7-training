export class SkillAudio {
  constructor(settings) { this.settings = settings; }

  play(type = 'hit', jobId = 'WHM') {
    if (!this.settings.sound) return;
    this.context ||= new (window.AudioContext || window.webkitAudioContext)();
    if (this.context.state === 'suspended') this.context.resume();
    const now = this.context.currentTime;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(this.settings.volume * 0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    gain.connect(this.context.destination);
    const oscillator = this.context.createOscillator();
    oscillator.type = jobId === 'RPR' ? 'triangle' : 'sine';
    const freq = type === 'buff' ? 780 : jobId === 'PCT' ? 620 : jobId === 'RPR' ? 180 : 460;
    oscillator.frequency.setValueAtTime(freq, now);
    oscillator.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.28);
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + 0.34);
    oscillator.onended = () => gain.disconnect();
  }
}
