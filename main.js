'use strict';

const Electron = require('electron');

var DEBUG_BUILDER = false;

function _runImportWorker(importFile, importerName, importer) {
  // add a error listener for import project abort
  var importWorker;
  var ErrorEvent = 'app:import-project-abort';
  function errorListener (event, err) {
    if (importWorker && !DEBUG_BUILDER) {
      var toDestroy = importWorker;
      importWorker = null;  // marked as destroying
      toDestroy.nativeWin.destroy();
    }

    Editor.error(err);
  }
  Electron.ipcMain.once(ErrorEvent, errorListener);

  // run a import worker for importing
  var registedClosedEvent = false;
  Editor.App.spawnWorker('app://editor/builtin/project-importer/core/import-worker', function(worker, browser) {
    importWorker = worker;

    var aborted;
    if (!registedClosedEvent) {
      registedClosedEvent = true;
      browser.once('closed', function () {
        if (!aborted) {
          Electron.ipcMain.removeListener(ErrorEvent, errorListener);
        }
      });
    }

    // use sendRequestToPage since disallow to use ipc here
    importWorker.send('app:init-import-worker', function (err) {
      if (err) {
        Editor.error(err);

        aborted = true;
        var destroyingWorker = !importWorker;
        if (!destroyingWorker && !DEBUG_BUILDER) {
          importWorker.close();
          importWorker = null;
        }
      }
      else if (importWorker) {
        Editor.Metrics.trackEvent({
          category: 'Project',
          action: 'Import Project',
          label: importerName
        });
        importWorker.send('app:import-project', importFile, importer, function (err) {
          if (err) {
            Editor.error(err);
          }

          var destroyingWorker = !importWorker;
          if (!destroyingWorker && !DEBUG_BUILDER) {
            importWorker.close();
            importWorker = null;
          }
        }, -1);
      }
    }, -1);
  }, DEBUG_BUILDER);
}

function getMenuItemLabel(name, exts) {
    var extStr = '';
    if (!exts) {
        extStr = Editor.T('MAIN_MENU.file.import_select_folder');
    } else {
        for (var i = 0, n = exts.length; i < n; i++) {
            if (extStr) {
                extStr += ',';
            }
            extStr += '*.' + exts[i];
        }
    }
    return Editor.T('MAIN_MENU.file.import_project_fmt', { name:name, exts: extStr });
}

function _open(name, exts, importer) {
    let title = getMenuItemLabel(name, exts);
    let result = null;
    if (exts) {
        result = Electron.dialog.showOpenDialogSync({
            title: title,
            filters: [
                {
                    name: name,
                    extensions: exts
                }
            ],
            properties: ['openFile']
        });
    } else {
        result = Electron.dialog.showOpenDialogSync({
            title: title,
            properties: ['openDirectory']
        });
    }

    if (result) {
        _runImportWorker(result[0], name, importer);
    }
}

module.exports = {
  messages: {
    'open-studio': function (event) {
      let studio = require("./core/studio/studio-importer");
      _open(studio.name, studio.exts, 'packages://project-importer/core/studio/studio-importer');
    },

    'open-builder': function (event) {
      let ccb = require("./core/ccb/ccbproj-importer");
      _open(ccb.name, ccb.exts, 'packages://project-importer/core/ccb/ccbproj-importer');
    }
  }
};
