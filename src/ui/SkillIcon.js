import mapping from './action-icons.json';
import { escape, icon } from './dom.js';

export function skillIcon(action) {
  const source = mapping[action.en] ? `${import.meta.env.BASE_URL}${mapping[action.en]}` : null;
  return source ? `<img class="game-skill-icon" src="${source}" alt="${escape(action.name)}" draggable="false" />` : icon(action.icon || 'sparkles');
}
