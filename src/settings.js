/**
 * Persistent settings store for the NDI companion.
 */

import Store from 'electron-store';

let store = null;

export function initSettings() {
  store = new Store({
    name: 'ndi-companion-settings',
    defaults: {},
  });
}

export function getSetting(key, fallback) {
  if (!store) return fallback;
  return store.get(key, fallback);
}

export function setSetting(key, value) {
  if (!store) return;
  store.set(key, value);
}
