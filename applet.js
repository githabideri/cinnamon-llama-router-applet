const Applet = imports.ui.applet;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

const REFRESH_SEC = 5;

function fetchModels(callback) {
    Util.spawn_async(['curl', '-s', '--max-time', '3', 'http://127.0.0.1:8082/models'], function(stdout) {
        if (!stdout || stdout.length === 0) {
            callback(null);
            return;
        }
        try {
            callback(JSON.parse(stdout));
        } catch (e) {
            logError(e, 'llama-router: parse failed');
            callback(null);
        }
    });
}

function loadModel(modelId) {
    let payload = JSON.stringify({
        model: modelId,
        messages: [{role: 'user', content: '\n'}],
        max_tokens: 1,
        temperature: 0
    });
    Util.spawn_async(['curl', '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', payload,
        '--max-time', '60',
        'http://127.0.0.1:8082/v1/chat/completions']);
}

function unloadModel(modelId) {
    let payload = JSON.stringify({model: modelId});
    Util.spawn_async(['curl', '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', payload,
        'http://127.0.0.1:8082/models/unload']);
}

class LlamaRouterApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instanceId) {
        super(orientation, panel_height, instanceId);

        this._models = [];
        this._online = false;
        this._switching = null;
        this._menuBuilt = false;

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.section);

        this.set_applet_label('?/4');
        this.set_applet_tooltip('Llama Router - click to switch models');

        // Initial refresh (data only, no menu rebuild)
        this._refresh();

        // Poll every 5 seconds
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SEC, () => {
            this._refresh();
            return true;
        });
    }

    on_applet_clicked(event) {
        this._buildMenu();
        this.menu.toggle();
    }

    on_applet_middle_click(event) {
        this._refresh();
    }

    _refresh() {
        let self = this;
        fetchModels(function(data) {
            self._online = !!(data && data.data);
            if (self._online) {
                self._models = data.data;
            }
            self._updateLabel();
            // Don't rebuild menu here - only on open
        });
    }

    _updateLabel() {
        if (!this._online) {
            this.set_applet_label('⚠');
            this.set_applet_tooltip('Llama Router\nStatus: offline');
            return;
        }

        let loaded = this._models
            .filter(m => m.status && m.status.value === 'loaded')
            .map(m => m.id);

        this.set_applet_label(loaded.length + '/' + this._models.length);

        let tip = 'Llama Router\nLoaded: ' + (loaded.join(', ') || 'none') + '\nTotal: ' + this._models.length;
        if (this._switching) {
            tip += '\n\nSwitching to: ' + this._switching + '...';
        }
        this.set_applet_tooltip(tip);
    }

    _buildMenu() {
        this.section.removeAll();
        let self = this;

        // Status header
        let statusLabel = this._online ? '● Online' : '○ Offline';
        let statusItem = new PopupMenu.PopupMenuItem(statusLabel);
        statusItem.setSensitive(false);
        this.section.addMenuItem(statusItem);

        this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (!this._online) {
            let infoItem = new PopupMenu.PopupMenuItem('Router not reachable at 127.0.0.1:8082');
            infoItem.setSensitive(false);
            this.section.addMenuItem(infoItem);

            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let retryItem = new PopupMenu.PopupMenuItem('↻ Retry');
            retryItem.connect('activate', () => this._refresh());
            this.section.addMenuItem(retryItem);

            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let restartItem = new PopupMenu.PopupMenuItem('⟳ Restart router');
            restartItem.connect('activate', () => {
                self.menu.close();
                Util.spawn(['bash', '-c', 'systemctl --user restart llama-router']);
            });
            this.section.addMenuItem(restartItem);
        } else {
            // Model list
            let loaded = this._models
                .filter(m => m.status && m.status.value === 'loaded')
                .map(m => m.id);

            let loadedLabel = 'Loaded: ' + (loaded.join(', ') || 'none');
            let loadedItem = new PopupMenu.PopupMenuItem(loadedLabel);
            loadedItem.setSensitive(false);
            this.section.addMenuItem(loadedItem);

            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (let i = 0; i < this._models.length; i++) {
                let m = this._models[i];
                let id = m.id;
                let status = m.status && m.status.value;
                let isLoaded = status === 'loaded';
                let icon = isLoaded ? '●' : (status === 'loading' ? '◐' : '○');
                let action = isLoaded ? 'Unload' : 'Load';
                let label = icon + ' ' + id + '  (' + action + ')';

                if (self._switching === id) {
                    label += ' ...';
                }

                let item = new PopupMenu.PopupMenuItem(label);
                item.connect('activate', () => {
                    log('llama-router: ' + action.toLowerCase() + ' ' + id);
                    self.menu.close();
                    if (isLoaded) {
                        unloadModel(id);
                    } else {
                        loadModel(id);
                    }
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        self._refresh();
                        return false;
                    });
                });
                this.section.addMenuItem(item);
            }

            this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Info note
            let noteItem = new PopupMenu.PopupMenuItem(this._models.length + ' models total, max 2 concurrent (LRU). Click to load/unload.');
            noteItem.setSensitive(false);
            this.section.addMenuItem(noteItem);
        }

        this.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh
        let refreshItem = new PopupMenu.PopupMenuItem('↻ Refresh');
        refreshItem.connect('activate', () => this._refresh());
        this.section.addMenuItem(refreshItem);

        // Settings
        let settingsItem = new PopupMenu.PopupMenuItem('⚙ Service config');
        settingsItem.connect('activate', () => {
            self.menu.close();
            Util.spawn(['xdg-open', 'file://' + GLib.get_home_dir() + '/.config/systemd/user/llama-router.service']);
        });
        this.section.addMenuItem(settingsItem);

        let presetItem = new PopupMenu.PopupMenuItem('⚙ Models preset');
        presetItem.connect('activate', () => {
            self.menu.close();
            Util.spawn(['xdg-open', 'file://' + GLib.get_home_dir() + '/models/models.ini']);
        });
        this.section.addMenuItem(presetItem);
    }
}

function main(metadata, orientation, panel_height, instanceId) {
    return new LlamaRouterApplet(metadata, orientation, panel_height, instanceId);
}
