'use strict';

const Async = require('async');
const Path = require('path');
const Fs = require('fire-fs');
const DOMParser = require('xmldom').DOMParser;
const Url = require('fire-url');
const Plist = require('plist');
const CSDImporter = require('./csd-importer');
const XmlUtils = require('./xml-utils');

const AssetsRootUrl = 'db://assets';
const ResFolderName = 'cocosstudio';
const TempFolderName = 'temp';

const FntPageEXP = /page [^\n]*(\n|$)/gi;
const FntItemExp = /\w+=[^ \r\n]+/gi;
const FntIntEXP  = /^[\-]?\d+$/;

var tempResPath = '';
var projectPath = '';
var resourcePath = '';
var newResourceUrl = '';
var projectName = '';
var csdFiles = [];

function importProject (projFile, cb) {
    Editor.log('Import Cocos Studio project : ', projFile);
    projectPath = Path.dirname(projFile);
    resourcePath = Path.join(projectPath, ResFolderName);
    if (!Fs.existsSync(resourcePath) || !Fs.isDirSync(resourcePath)) {
        cb(new Error(`Resource directory ${resourcePath} is not existed.`));
        return;
    }

    var fileContent = Fs.readFileSync(projFile, 'utf-8');
    var doc = new DOMParser().parseFromString(fileContent);
    if (!doc) {
        cb(new Error(`Parse ${projFile} failed.`));
        return;
    }

    var rootElement = doc.documentElement;

    // parse the project information
    try {
        _parseProjectInfo(rootElement);
    } catch (err) {
        cb(new Error('Illegal format of project file.'));
        return;
    }

    _createTempResPath();

    // import the resource files
    try {
        // create a folder with project name in assets
        _createAssetFolder(resourcePath);

        var elements = rootElement.getElementsByTagName('SolutionFolder');
        elements = elements[0].getElementsByTagName('Group');
        elements = elements[0].getElementsByTagName('RootFolder');
        var element = elements[0];
        _importResources(element, resourcePath);

        Async.waterfall([
            function(next) {
                // import raw assets
                Editor.assetdb.import([tempResPath], AssetsRootUrl, false, function(err, results) {
                    next();
                });
            },
            function(next) {
                // import csd files
                CSDImporter.importCSDFiles(csdFiles, resourcePath, tempResPath, newResourceUrl, next);
            }
        ], function () {
            Editor.log('Import Cocos Studio project finished.');
            Editor.log('Resources are imported to folder : %s', newResourceUrl);

            _removeTempResPath();
            cb();
        });
    } catch (err) {
        // TODO remove temp path if error occurred???
        //_removeTempResPath();

        cb(new Error('Import resource files failed.'));
    }
}

function _parseProjectInfo (rootNode) {
    var propElements = rootNode.getElementsByTagName('PropertyGroup');
    var propNode = propElements[0];
    projectName = propNode.getAttribute('Name');
    var projVer = propNode.getAttribute('Version');

    newResourceUrl = Url.join(AssetsRootUrl, projectName);
    // var i = 1;
    // while (Fs.existsSync(Editor.assetdb.remote._fspath(newResourceUrl))) {
    //     newResourceUrl = Url.join(AssetsRootUrl, projectName + '_' + i);
    //     i++;
    // }

    Editor.log('Project Name : %s, Cocos Studio Version : %s', projectName, projVer);
}

function _rmdirRecursive (path) {
    if( Fs.existsSync(path) ) {
        Fs.readdirSync(path).forEach(function(file){
            var curPath = Path.join(path, file);
            if(Fs.lstatSync(curPath).isDirectory()) { // recurse
                _rmdirRecursive(curPath);
            } else { // delete file
                Fs.unlinkSync(curPath);
            }
        });
        Fs.rmdirSync(path);
    }
}

function _createTempResPath() {
    // create a temp path for import project
    var folderName = Url.basename(newResourceUrl);
    tempResPath = Path.join(Editor.remote.Project.path, TempFolderName, folderName);
    if (Fs.existsSync(tempResPath)) {
        _rmdirRecursive(tempResPath);
    }

    Fs.mkdirsSync(tempResPath);
}

function _removeTempResPath() {
    try {
        _rmdirRecursive(tempResPath);
    } catch (err) {
        Editor.warn('Delete temp path %s failed, please delete it manually!', tempResPath);
    }
}

function _importAsset(filePath) {
    if (! Fs.existsSync(filePath)) {
        Editor.warn('%s is not found!', filePath);
        return;
    }

    var relativePath = Path.relative(resourcePath, filePath);
    var targetPath = Path.join(tempResPath, relativePath);
    if (Fs.existsSync(targetPath)) {
        return;
    }

    Fs.copySync(filePath, targetPath);
}

function _createAssetFolder(folderPath) {
    var relativePath = Path.relative(resourcePath, folderPath);
    var newFsPath = Path.join(tempResPath, relativePath);
    if (!Fs.existsSync(newFsPath)) {
        Fs.mkdirsSync(newFsPath);
    }
}

function _importParticle(particleFile) {
    _importAsset(particleFile);

    if (!Fs.existsSync(particleFile)) {
        return;
    }

    var dict = Plist.parse(Fs.readFileSync(particleFile, 'utf8'));
    if (dict) {
        var imgPath = Path.join(Path.dirname(particleFile), dict['textureFileName']);
        if (Fs.existsSync(imgPath)) {
            _importAsset(imgPath);
        }
    }
}

function _importTMX(tmxFile) {
    _importAsset(tmxFile);

    if (!Fs.existsSync(tmxFile)) {
        return;
    }

    var fileContent = Fs.readFileSync(tmxFile, 'utf-8');
    var doc = new DOMParser().parseFromString(fileContent);
    if (!doc) {
        Editor.warn('Parse %s failed.', tmxFile);
        return;
    }

    function _importTilesetImages(tilesetNode, sourcePath) {
        var images = tilesetNode.getElementsByTagName('image');
        for (var i = 0, n = images.length; i < n ; i++) {
            var imageCfg = images[i].getAttribute('source');
            if (imageCfg) {
                var imgPath = Path.join(Path.dirname(sourcePath), imageCfg);
                _importAsset(imgPath);
            }
        }
    }

    var rootElement = doc.documentElement;
    var tilesetElements = rootElement.getElementsByTagName('tileset');
    for (var i = 0, n = tilesetElements.length; i < n; i++) {
        var tileset = tilesetElements[i];
        var sourceTSX = tileset.getAttribute('source');
        if (sourceTSX) {
            var tsxPath = Path.join(Path.dirname(tmxFile), sourceTSX);
            _importAsset(tsxPath);

            if (Fs.existsSync(tsxPath)) {
                var tsxContent = Fs.readFileSync(tsxPath, 'utf-8');
                var tsxDoc = new DOMParser().parseFromString(tsxContent);
                if (tsxDoc) {
                    _importTilesetImages(tsxDoc, tsxPath);
                } else {
                    Editor.warn('Parse %s failed.', tsxPath);
                }
            }
        }

        // import images
        _importTilesetImages(tileset, tmxFile);
    }
}

function _importFNT(fntFile) {
    _importAsset(fntFile);

    if (!Fs.existsSync(fntFile)) {
        return;
    }

    var fntContent = Fs.readFileSync(fntFile, 'utf8');
    var matchCfgs = fntContent.match(FntPageEXP);
    if (!matchCfgs || matchCfgs.length === 0) {
        Editor.warn('Parse fnt file %s failed!', fntFile);
        return;
    }

    var pageCfg = matchCfgs[0];
    var arr = pageCfg.match(FntItemExp);
    if (arr) {
        var pageObj = {};
        for (var i = 0, li = arr.length; i < li; i++) {
            var tempStr = arr[i];
            var index = tempStr.indexOf('=');
            var key = tempStr.substring(0, index);
            var value = tempStr.substring(index + 1);
            if (value.match(FntIntEXP)) value = parseInt(value);
            else if (value[0] === '"') value = value.substring(1, value.length - 1);
            pageObj[key] = value;
        }

        if (pageObj.file) {
            var imgPath = Path.join(Path.dirname(fntFile), pageObj.file);
            _importAsset(imgPath);
        } else {
            Editor.warn('Get image file config from fnt file %s failed!', fntFile);
        }
    } else {
        Editor.warn('Get "page" config from fnt file %s failed!', fntFile);
    }
}

function _importResources(node, resPath) {
    for (var i = 0, n = node.childNodes.length; i < n; i++) {
        var child = node.childNodes[i];
        if (XmlUtils.shouldIgnoreNode(child)) {
            continue;
        }

        var nameAttr = child.getAttribute('Name');
        var filePath = Path.join(resPath, nameAttr);
        switch (child.nodeName) {
            case 'Folder':
                _createAssetFolder(filePath);
                _importResources(child, filePath);
                break;
            case 'Project':
                // csd file, record it
                csdFiles.push(filePath);
                break;
            case 'PlistInfo':
                // csi file, do nothing
                break;
            case 'Image':
            case 'TTF':
            case 'Audio':
                _importAsset(filePath);
                break;
            case 'PlistImageFolder':
                var plistFile = Path.join(resPath, child.getAttribute('PListFile'));
                _importAsset(plistFile);
                var imgFile = Path.join(resPath, child.getAttribute('Image'));
                _importAsset(imgFile);
                break;
            case 'Fnt':
                _importFNT(filePath);
                break;
            case 'PlistParticleFile':
                _importParticle(filePath);
                break;
            case 'TmxFile':
                _importTMX(filePath);
                break;
            default:
                break;
        }
    }
}

module.exports = {
    name: 'Cocos Studio',
    exts: 'ccs',
    importer: importProject,
};
