// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Caribou = imports.gi.Caribou;
const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const BoxPointer = imports.ui.boxpointer;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const KEYBOARD_REST_TIME = Layout.KEYBOARD_ANIMATION_TIME * 2 * 1000;

const KEYBOARD_SCHEMA = 'org.gnome.shell.keyboard';
const KEYBOARD_TYPE = 'keyboard-type';

const A11Y_APPLICATIONS_SCHEMA = 'org.gnome.desktop.a11y.applications';
const SHOW_KEYBOARD = 'screen-keyboard-enabled';

const CaribouKeyboardIface = <interface name='org.gnome.Caribou.Keyboard'>
<method name='Show'>
    <arg type='u' direction='in' />
</method>
<method name='Hide'>
    <arg type='u' direction='in' />
</method>
<method name='SetCursorLocation'>
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
</method>
<method name='SetEntryLocation'>
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
    <arg type='i' direction='in' />
</method>
<property name='Name' access='read' type='s' />
</interface>;

const Key = new Lang.Class({
    Name: 'Key',

    _init : function(key) {
        this._key = key;

        this.actor = this._makeKey();

        this._extended_keys = this._key.get_extended_keys();
        this._extended_keyboard = null;

        if (this._key.name == 'Control_L' || this._key.name == 'Alt_L')
            this._key.latch = true;

        if (this._extended_keys.length > 0) {
            this._key.connect('notify::show-subkeys', Lang.bind(this, this._onShowSubkeysChanged));
            this._boxPointer = new BoxPointer.BoxPointer(St.Side.BOTTOM,
                                                         { x_fill: true,
                                                           y_fill: true,
                                                           x_align: St.Align.START });
            // Adds style to existing keyboard style to avoid repetition
            this._boxPointer.actor.add_style_class_name('keyboard-subkeys');
            this._getExtendedKeys();
            this.actor._extended_keys = this._extended_keyboard;
            this._boxPointer.actor.hide();
            Main.layoutManager.addChrome(this._boxPointer.actor);
        }
    },

    _makeKey: function () {
        let label = GLib.markup_escape_text(this._key.label, -1);
        let button = new St.Button ({ label: label,
                                      style_class: 'keyboard-key' });

        button.key_width = this._key.width;
        button.connect('button-press-event', Lang.bind(this, function () { this._key.press(); }));
        button.connect('button-release-event', Lang.bind(this, function () { this._key.release(); }));

        return button;
    },

    _getUnichar: function(key) {
        let keyval = key.keyval;
        let unichar = Gdk.keyval_to_unicode(keyval);
        if (unichar) {
            return String.fromCharCode(unichar);
        } else {
            return key.name;
        }
    },

    _getExtendedKeys: function () {
        this._extended_keyboard = new St.BoxLayout({ style_class: 'keyboard-layout',
                                                     vertical: false });
        for (let i = 0; i < this._extended_keys.length; ++i) {
            let extended_key = this._extended_keys[i];
            let label = this._getUnichar(extended_key);
            let key = new St.Button({ label: label, style_class: 'keyboard-key' });
            key.extended_key = extended_key;
            key.connect('button-press-event', Lang.bind(this, function () { extended_key.press(); }));
            key.connect('button-release-event', Lang.bind(this, function () { extended_key.release(); }));
            this._extended_keyboard.add(key);
        }
        this._boxPointer.bin.add_actor(this._extended_keyboard);
    },

    get subkeys() {
        return this._boxPointer;
    },

    _onShowSubkeysChanged: function () {
        if (this._key.show_subkeys) {
            this._boxPointer.actor.raise_top();
            this._boxPointer.setPosition(this.actor, 0.5);
            this.emit('show-subkeys');
            this.actor.fake_release();
            this.actor.set_hover(false);
        } else {
            this.emit('hide-subkeys');
        }
    }
});
Signals.addSignalMethods(Key.prototype);

const Keyboard = new Lang.Class({
    // HACK: we can't set Name, because it collides with Name dbus property
    // Name: 'Keyboard',

    _init: function () {
        this._impl = Gio.DBusExportedObject.wrapJSObject(CaribouKeyboardIface, this);
        this._impl.export(Gio.DBus.session, '/org/gnome/Caribou/Keyboard');

        this.actor = null;
        this._focusInTray = false;
        this._focusInExtendedKeys = false;

        this._timestamp = global.display.get_current_time_roundtrip();
        Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._redraw));

        this._keyboardSettings = new Gio.Settings({ schema: KEYBOARD_SCHEMA });
        this._keyboardSettings.connect('changed', Lang.bind(this, this._settingsChanged));
        this._a11yApplicationsSettings = new Gio.Settings({ schema: A11Y_APPLICATIONS_SCHEMA });
        this._a11yApplicationsSettings.connect('changed', Lang.bind(this, this._settingsChanged));
        this._settingsChanged();

        this._showIdleId = 0;
        this._subkeysBoxPointer = null;
        this._capturedEventId = 0;
        this._capturedPress = false;

        this._keyboardVisible = false;
        Main.layoutManager.connect('keyboard-visible-changed', Lang.bind(this, function(o, visible) {
            this._keyboardVisible = visible;
        }));
        this._keyboardRequested = false;
        this._keyboardRestingId = 0;
    },

    init: function () {
        this._redraw();
    },

    _settingsChanged: function (settings, key) {
        this._enableKeyboard = this._a11yApplicationsSettings.get_boolean(SHOW_KEYBOARD);
        if (!this._enableKeyboard && !this._keyboard)
            return;
        if (this._enableKeyboard && this._keyboard &&
            this._keyboard.keyboard_type == this._keyboardSettings.get_string(KEYBOARD_TYPE))
            return;

        if (this._keyboard)
            this._destroyKeyboard();

        if (this._enableKeyboard) {
            // If we've been called because the setting actually just
            // changed to true (as opposed to being called from
            // this._init()), then we want to pop up the keyboard.
            let showKeyboard = (settings != null);

            // However, caribou-gtk-module or this._onKeyFocusChanged
            // will probably immediately tell us to hide it, so we
            // have to fake things out so we'll ignore that request.
            if (showKeyboard)
                this._timestamp = global.display.get_current_time_roundtrip() + 1;
            this._setupKeyboard(showKeyboard);
        } else
            Main.layoutManager.hideKeyboard(true);
    },

    _destroyKeyboard: function() {
        if (this._keyboardNotifyId)
            this._keyboard.disconnect(this._keyboardNotifyId);
        if (this._focusNotifyId)
            global.stage.disconnect(this._focusNotifyId);
        this._keyboard = null;
        this.actor.destroy();
        this.actor = null;

        this._destroySource();
    },

    _setupKeyboard: function(show) {
        this.actor = new St.BoxLayout({ name: 'keyboard', vertical: true, reactive: true });
        Main.layoutManager.keyboardBox.add_actor(this.actor);
        Main.layoutManager.trackChrome(this.actor);

        this._keyboard = new Caribou.KeyboardModel({ keyboard_type: this._keyboardSettings.get_string(KEYBOARD_TYPE) });
        this._groups = {};
        this._current_page = null;

        // Initialize keyboard key measurements
        this._numOfHorizKeys = 0;
        this._numOfVertKeys = 0;

        this._addKeys();

        // Keys should be layout according to the group, not the
        // locale; as Caribou already provides the expected layout,
        // this means enforcing LTR for all locales.
        this.actor.text_direction = Clutter.TextDirection.LTR;

        this._keyboardNotifyId = this._keyboard.connect('notify::active-group', Lang.bind(this, this._onGroupChanged));
        this._focusNotifyId = global.stage.connect('notify::key-focus', Lang.bind(this, this._onKeyFocusChanged));

        if (show)
            this.show(Main.layoutManager.focusIndex);
        else
            this._createSource();
    },

    _onKeyFocusChanged: function () {
        let focus = global.stage.key_focus;

        // Showing an extended key popup and clicking a key from the extended keys
        // will grab focus, but ignore that
        let extendedKeysWereFocused = this._focusInExtendedKeys;
        this._focusInExtendedKeys = focus && (focus._extended_keys || focus.extended_key);
        if (this._focusInExtendedKeys || extendedKeysWereFocused)
            return;

        // Ignore focus changes caused by message tray showing/hiding
        let trayWasFocused = this._focusInTray;
        this._focusInTray = (focus && Main.messageTray.actor.contains(focus));
        if (this._focusInTray || trayWasFocused)
            return;

        let time = global.get_current_time();
        if (!(focus instanceof Clutter.Text)) {
            this.Hide(time);
            return;
        }

        if (!this._showIdleId)
            this._showIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE,
                                             Lang.bind(this, function() { this.Show(time); }));
    },

    _addKeys: function () {
        let groups = this._keyboard.get_groups();
        for (let i = 0; i < groups.length; ++i) {
             let gname = groups[i];
             let group = this._keyboard.get_group(gname);
             group.connect('notify::active-level', Lang.bind(this, this._onLevelChanged));
             let layers = {};
             let levels = group.get_levels();
             for (let j = 0; j < levels.length; ++j) {
                 let lname = levels[j];
                 let level = group.get_level(lname);
                 let layout = new St.BoxLayout({ style_class: 'keyboard-layout',
                                                 vertical: true });
                 this._loadRows(level, layout);
                 layers[lname] = layout;
                 this.actor.add(layout, { x_fill: false });

                 layout.hide();
             }
             this._groups[gname] = layers;
        }

        this._setActiveLayer();
    },

    _getTrayIcon: function () {
        let trayButton = new St.Button ({ label: _("tray"),
                                          style_class: 'keyboard-key' });
        trayButton.key_width = 1;
        trayButton.connect('button-press-event', Lang.bind(this, function () {
            Main.messageTray.toggle();
        }));

        Main.overview.connect('showing', Lang.bind(this, function () {
            trayButton.reactive = false;
            trayButton.add_style_pseudo_class('grayed');
        }));
        Main.overview.connect('hiding', Lang.bind(this, function () {
            trayButton.reactive = true;
            trayButton.remove_style_pseudo_class('grayed');
        }));
        Main.sessionMode.connect('updated', Lang.bind(this, function() {
            trayButton.reactive = !Main.sessionMode.isLocked;
            if (Main.sessionMode.isLocked)
                trayButton.add_style_pseudo_class('grayed');
            else
                trayButton.remove_style_pseudo_class('grayed');
        }));

        return trayButton;
    },

    _onCapturedEvent: function(actor, event) {
        let type = event.type();
        let press = type == Clutter.EventType.BUTTON_PRESS;
        let release = type == Clutter.EventType.BUTTON_RELEASE;

        if (press)
            this._capturedPress = true;
        else if (release && this._capturedPress)
            this._hideSubkeys();

        return true;
    },

    _addRows : function (keys, layout) {
        let keyboard_row = new St.BoxLayout();
        for (let i = 0; i < keys.length; ++i) {
            let children = keys[i].get_children();
            let right_box = new St.BoxLayout({ style_class: 'keyboard-row' });
            let left_box = new St.BoxLayout({ style_class: 'keyboard-row' });
            for (let j = 0; j < children.length; ++j) {
                if (this._numOfHorizKeys == 0)
                    this._numOfHorizKeys = children.length;
                let key = children[j];
                let button = new Key(key);

                if (key.align == 'right')
                    right_box.add(button.actor);
                else
                    left_box.add(button.actor);
                if (key.name == 'Caribou_Prefs') {
                    key.connect('key-released', Lang.bind(this, this.hide));

                    // Add new key for hiding message tray
                    right_box.add(this._getTrayIcon());
                }

                button.connect('show-subkeys', Lang.bind(this, function() {
                    if (this._subkeysBoxPointer)
                        this._subkeysBoxPointer.hide(BoxPointer.PopupAnimation.FULL);
                    this._subkeysBoxPointer = button.subkeys;
                    this._subkeysBoxPointer.show(BoxPointer.PopupAnimation.FULL);
                    if (!this._capturedEventId)
                        this._capturedEventId = this.actor.connect('captured-event',
                                                                   Lang.bind(this, this._onCapturedEvent));
                }));
                button.connect('hide-subkeys', Lang.bind(this, function() {
                    this._hideSubkeys();
                }));
            }
            keyboard_row.add(left_box, { expand: true, x_fill: false, x_align: St.Align.START });
            keyboard_row.add(right_box, { expand: true, x_fill: false, x_align: St.Align.END });
        }
        layout.add(keyboard_row);
    },

    _loadRows : function (level, layout) {
        let rows = level.get_rows();
        for (let i = 0; i < rows.length; ++i) {
            let row = rows[i];
            if (this._numOfVertKeys == 0)
                this._numOfVertKeys = rows.length;
            this._addRows(row.get_columns(), layout);
        }

    },

    _redraw: function () {
        if (!this._enableKeyboard)
            return;

        let monitor = Main.layoutManager.keyboardMonitor;
        let maxHeight = monitor.height / 3;
        this.actor.width = monitor.width;

        let layout = this._current_page;
        let verticalSpacing = layout.get_theme_node().get_length('spacing');
        let padding = layout.get_theme_node().get_length('padding');

        let box = layout.get_children()[0].get_children()[0];
        let horizontalSpacing = box.get_theme_node().get_length('spacing');
        let allHorizontalSpacing = (this._numOfHorizKeys - 1) * horizontalSpacing;
        let keyWidth = Math.floor((this.actor.width - allHorizontalSpacing - 2 * padding) / this._numOfHorizKeys);

        let allVerticalSpacing = (this._numOfVertKeys - 1) * verticalSpacing;
        let keyHeight = Math.floor((maxHeight - allVerticalSpacing - 2 * padding) / this._numOfVertKeys);

        let keySize = Math.min(keyWidth, keyHeight);
        this.actor.height = keySize * this._numOfVertKeys + allVerticalSpacing + 2 * padding;

        let rows = this._current_page.get_children();
        for (let i = 0; i < rows.length; ++i) {
            let keyboard_row = rows[i];
            let boxes = keyboard_row.get_children();
            for (let j = 0; j < boxes.length; ++j) {
                let keys = boxes[j].get_children();
                for (let k = 0; k < keys.length; ++k) {
                    let child = keys[k];
                    child.width = keySize * child.key_width;
                    child.height = keySize;
                    if (child._extended_keys) {
                        let extended_keys = child._extended_keys.get_children();
                        for (let n = 0; n < extended_keys.length; ++n) {
                            let extended_key = extended_keys[n];
                            extended_key.width = keySize;
                            extended_key.height = keySize;
                        }
                    }
                }
            }
        }
    },

    _onLevelChanged: function () {
        this._setActiveLayer();
        this._redraw();
    },

    _onGroupChanged: function () {
        this._setActiveLayer();
        this._redraw();
    },

    _setActiveLayer: function () {
        let active_group_name = this._keyboard.active_group;
        let active_group = this._keyboard.get_group(active_group_name);
        let active_level = active_group.active_level;
        let layers = this._groups[active_group_name];

        if (this._current_page != null) {
            this._current_page.hide();
        }

        this._current_page = layers[active_level];
        this._current_page.show();
    },

    _createSource: function () {
        if (this._source == null) {
            this._source = new KeyboardSource(this);
            this._source.setTransient(true);
            Main.messageTray.add(this._source);
        }
    },

    _destroySource: function () {
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    },

    shouldTakeEvent: function(event) {
        let actor = event.get_source();
        return Main.layoutManager.keyboardBox.contains(actor) ||
               actor._extended_keys || actor.extended_key;
    },

    _clearKeyboardRestTimer: function() {
        if (!this._keyboardRestingId)
            return;
        GLib.source_remove(this._keyboardRestingId);
        this._keyboardRestingId = 0;
    },

    show: function (monitor) {
        this._keyboardRequested = true;

        if (this._keyboardVisible) {
            if (monitor != Main.layoutManager.keyboardIndex) {
                Main.layoutManager.keyboardIndex = monitor;
                this._redraw();
            }
            return;
        }

        this._clearKeyboardRestTimer();
        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                                   KEYBOARD_REST_TIME,
                                                   Lang.bind(this, function() {
                                                       this._clearKeyboardRestTimer();
                                                       this._show(monitor);
                                                   }));
    },

    _show: function(monitor) {
        if (!this._keyboardRequested)
            return;

        Main.layoutManager.keyboardIndex = monitor;
        this._redraw();
        Main.layoutManager.showKeyboard();
        this._destroySource();
    },

    hide: function () {
        this._keyboardRequested = false;

        if (!this._keyboardVisible)
            return;

        this._clearKeyboardRestTimer();
        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                                   KEYBOARD_REST_TIME,
                                                   Lang.bind(this, function() {
                                                       this._clearKeyboardRestTimer();
                                                       this._hide();
                                                   }));
    },

    _hide: function() {
        if (this._keyboardRequested)
            return;

        this._hideSubkeys();
        Main.layoutManager.hideKeyboard();
        this._createSource();
    },

    _hideSubkeys: function() {
        if (this._subkeysBoxPointer) {
            this._subkeysBoxPointer.hide(BoxPointer.PopupAnimation.FULL);
            this._subkeysBoxPointer = null;
        }
        if (this._capturedEventId) {
            this.actor.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
        this._capturedPress = false;
    },

    _moveTemporarily: function () {
        let currentWindow = global.screen.get_display().focus_window;
        let rect = currentWindow.get_outer_rect();

        let newX = rect.x;
        let newY = 3 * this.actor.height / 2;
        currentWindow.move_frame(true, newX, newY);
    },

    _setLocation: function (x, y) {
        if (y >= 2 * this.actor.height)
            this._moveTemporarily();
    },

    // _compareTimestamp:
    //
    // Compare two timestamps taking into account
    // CURRENT_TIME (0)
    _compareTimestamp: function(one, two) {
        if (one == two)
            return 0;
        if (one == Clutter.CURRENT_TIME)
            return 1;
        if (two == Clutter.CURRENT_TIME)
            return -1;
        return one - two;
    },

    _clearShowIdle: function() {
        if (!this._showIdleId)
            return;
        GLib.source_remove(this._showIdleId);
        this._showIdleId = 0;
    },

    // D-Bus methods
    Show: function(timestamp) {
        if (!this._enableKeyboard)
            return;

        if (this._compareTimestamp(timestamp, this._timestamp) < 0)
            return;

        this._clearShowIdle();

        if (timestamp != Clutter.CURRENT_TIME)
            this._timestamp = timestamp;
        this.show(Main.layoutManager.focusIndex);
    },

    Hide: function(timestamp) {
        if (!this._enableKeyboard)
            return;

        if (this._compareTimestamp(timestamp, this._timestamp) < 0)
            return;

        this._clearShowIdle();

        if (timestamp != Clutter.CURRENT_TIME)
            this._timestamp = timestamp;
        this.hide();
    },

    SetCursorLocation: function(x, y, w, h) {
        if (!this._enableKeyboard)
            return;

//        this._setLocation(x, y);
    },

    SetEntryLocation: function(x, y, w, h) {
        if (!this._enableKeyboard)
            return;

//        this._setLocation(x, y);
    },

    get Name() {
        return 'gnome-shell';
    }
});

const KeyboardSource = new Lang.Class({
    Name: 'KeyboardSource',
    Extends: MessageTray.Source,

    _init: function(keyboard) {
        this._keyboard = keyboard;
        this.parent(_("Keyboard"), 'input-keyboard-symbolic');
        this.keepTrayOnSummaryClick = true;
    },

    handleSummaryClick: function(button) {
        this.open();
        return true;
    },

    open: function() {
        // Show the OSK below the message tray
        this._keyboard.show(Main.layoutManager.bottomIndex);
    }
});
