import { buildCity } from '../terrain/buildCity.js';

export const SCENE_BUILDERS = { gridania: (state, group) => buildCity(state, group, 'gridania'), limsa: (state, group) => buildCity(state, group, 'limsa') };
