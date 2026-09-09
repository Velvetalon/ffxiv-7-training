// Visual themes are independent of costs, potency and job state.
export function actionColor(action, job) {
  if (action.color) return action.color;
  if (action.heal || /heal|Regen|Medica|Lily/i.test(action.effect || '')) return '#69b59c';
  if (/shield|heart-handshake/.test(action.icon || '')) return '#76a8bf';
  if (job.id === 'PCT') {
    if (/Red/.test(action.en)) return '#e18677';
    if (/Green/.test(action.en)) return '#81bf9a';
    if (/Blue|Cyan/.test(action.en)) return '#79b9d5';
    if (/Yellow|Hammer|Steel/.test(action.en)) return '#e0b969';
    if (/Magenta|Comet/.test(action.en)) return '#b783c3';
    if (/Star|Prism|Rainbow/.test(action.en)) return '#91c9c4';
    return '#c695bd';
  }
  if (job.id === 'RPR') return action.gcd ? '#ac7f9d' : '#8175ac';
  return action.gcd ? '#cfbd88' : '#8db6c1';
}
