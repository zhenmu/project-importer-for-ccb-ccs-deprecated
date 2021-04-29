(() => {
    'use strict';

    // page-level worker
    const Path = require('path');
    const Electron = require('electron');
    const ipcRenderer = Electron.ipcRenderer;

    window.onerror = function (p1, p2, p3, p4, error) {
        window.onerror = null;
        Editor.Ipc.sendToMain('app:import-project-abort', error.stack);
    };

    // 必须立刻监听 IPC，否则会漏接收消息，所以初始化放到 IPC 回调里再进行
    ipcRenderer.on('app:init-import-worker', function (event) {
        
        // 注册 scene 协议
        let sceneRoot = Editor.url('app://editor/page/scene-utils');
        Editor.Protocol.register('scene', (uri) => {
            return Path.join(sceneRoot, uri.hostname || '', uri.path || '');
        });

        Editor.require('app://editor/share/editor-utils');
        Editor.require('unpack://engine-dev');
        Editor.require('app://editor/page/engine-extends');
        Editor.require('app://editor/share/engine-extends/init');
        Editor.require('app://editor/share/engine-extends/serialize');
        Editor.require('app://editor/share/register-builtin-assets');
        Editor.require('app://editor/page/asset-db');
        Editor.require('app://editor/page/scene-utils');

        const Async = require('async');
        Async.waterfall([
            // init engine
            function (next) {
                var importSrc = Editor.remote.importPath.replace(/\\/g, '/');
                cc.assetManager.init({
                    importBase: importSrc,
                    nativeBase: importSrc
                });

                var canvas = document.createElement('canvas');
                document.body.appendChild(canvas);
                canvas.id = 'engine-canvas';

                cc.game.run({
                    width: 800,
                    height: 600,
                    id: 'engine-canvas',
                    debugMode: cc.debug.DebugMode.INFO,
                }, next);
            }],
            event.reply
        );
    });

    ipcRenderer.on('app:import-project', function (event, importFile, importer) {
        var importerObj = Editor.require(importer);
        if (importerObj.importer) {
            importerObj.importer(importFile, (...args) => {
                event.reply(...args);
            });
        } else {
            event.reply(new Error('Not found correct importer.'));
        }
    });
})();
