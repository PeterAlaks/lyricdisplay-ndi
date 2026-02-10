/**
 * LyricDisplay NDI Companion - Settings Manager
 * Reads and watches the ndi-settings.json file from the main LyricDisplay app's electron-store
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { watch } from 'chokidar';
import { EventEmitter } from 'events';

class SettingsManager extends EventEmitter {
  constructor() {
    super();
    this.settings = null;
    this.watcher = null;
    this.settingsPath = this._resolveSettingsPath();
  }

  /**
   * Resolve the path to the ndi-settings.json file
   * electron-store saves to the app's userData directory
   */
  _resolveSettingsPath() {
    let userDataPath;

    if (process.platform === 'win32') {
      userDataPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'lyric-display-app');
    } else if (process.platform === 'darwin') {
      userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'lyric-display-app');
    } else {
      userDataPath = path.join(os.homedir(), '.config', 'lyric-display-app');
    }

    return path.join(userDataPath, 'ndi-settings.json');
  }

  /**
   * Load settings from disk
   */
  load() {
    try {
      if (!fs.existsSync(this.settingsPath)) {
        console.warn('[Settings] Settings file not found at:', this.settingsPath);
        this.settings = this._getDefaults();
        return this.settings;
      }

      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      this.settings = JSON.parse(raw);
      console.log('[Settings] Loaded settings from:', this.settingsPath);
      return this.settings;
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error.message);
      this.settings = this._getDefaults();
      return this.settings;
    }
  }

  /**
   * Start watching the settings file for changes
   */
  startWatching() {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.settingsPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    this.watcher.on('change', () => {
      console.log('[Settings] Settings file changed, reloading...');
      const oldSettings = JSON.parse(JSON.stringify(this.settings || {}));
      this.load();
      this.emit('changed', this.settings, oldSettings);
    });

    console.log('[Settings] Watching for changes:', this.settingsPath);
  }

  /**
   * Stop watching the settings file
   */
  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[Settings] Stopped watching settings file');
    }
  }

  /**
   * Get settings for a specific output
   */
  getOutputSettings(outputKey) {
    if (!this.settings || !this.settings.outputs) {
      return this._getDefaultOutput(outputKey);
    }
    return this.settings.outputs[outputKey] || this._getDefaultOutput(outputKey);
  }

  /**
   * Get all enabled outputs with resolved resolution dimensions
   */
  getEnabledOutputs() {
    if (!this.settings || !this.settings.outputs) return [];

    return Object.entries(this.settings.outputs)
      .filter(([_, config]) => config.enabled)
      .map(([key, config]) => ({
        key,
        ...config,
        ...this._resolveResolution(config)
      }));
  }

  /**
   * Resolve resolution to width/height
   */
  _resolveResolution(config) {
    const presets = {
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 },
      '4k': { width: 3840, height: 2160 }
    };

    if (config.resolution === 'custom' && config.customWidth && config.customHeight) {
      return {
        width: Math.max(320, Math.min(7680, config.customWidth)),
        height: Math.max(240, Math.min(4320, config.customHeight))
      };
    }

    return presets[config.resolution] || presets['1080p'];
  }

  /**
   * Default settings
   */
  _getDefaults() {
    return {
      installed: false,
      version: '',
      installPath: '',
      autoLaunch: false,
      outputs: {
        output1: this._getDefaultOutput('output1'),
        output2: this._getDefaultOutput('output2'),
        stage: this._getDefaultOutput('stage')
      }
    };
  }

  _getDefaultOutput(outputKey) {
    const nameMap = {
      output1: 'LyricDisplay Output 1',
      output2: 'LyricDisplay Output 2',
      stage: 'LyricDisplay Stage'
    };
    return {
      enabled: false,
      resolution: '1080p',
      customWidth: 1920,
      customHeight: 1080,
      framerate: 30,
      sourceName: nameMap[outputKey] || `LyricDisplay ${outputKey}`
    };
  }

  /**
   * Clean up
   */
  destroy() {
    this.stopWatching();
    this.removeAllListeners();
  }
}

export default SettingsManager;
