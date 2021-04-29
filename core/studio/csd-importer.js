'use strict';

const Async = require('async');
const DOMParser = require('xmldom').DOMParser;
const Fs = require('fire-fs');
const Path = require('fire-path');
const Url = require('fire-url');
const XmlUtils = require('./xml-utils');

const INTERNAL = 'db://internal/';
const DEFAULT_SP_URL = 'db://internal/image/default_sprite.png/default_sprite';
const DEFAULT_SPLASH_SP_URL = 'db://internal/image/default_sprite_splash.png/default_sprite_splash';
const DEFAULT_PARTICLE_URL = 'db://internal/particle/atom.plist';
const DEFAULT_BTN_NORMAL_URL = 'db://internal/image/default_btn_normal.png/default_btn_normal';
const DEFAULT_BTN_PRESSED_URL = 'db://internal/image/default_btn_pressed.png/default_btn_pressed';
const DEFAULT_BTN_DISABLED_URL = 'db://internal/image/default_btn_disabled.png/default_btn_disabled';
const DEFAULT_PROGRESSBAR_URL = 'db://internal/image/default_progressbar.png/default_progressbar';
const DEFAULT_VSCROLLBAR_URL = 'db://internal/image/default_scrollbar_vertical.png/default_scrollbar_vertical';
const DEFAULT_HSCROLLBAR_URL = 'db://internal/image/default_scrollbar.png/default_scrollbar';
const DEFAULT_PANEL_URL = 'db://internal/image/default_panel.png/default_panel';

const ACTION_FOLDER_SUFFIX = '_action';
const DEFAULT_ACTION_FPS = 60;

const PATH_SEPERATOR = /[\\\/]/g;

const nodeImporters = {
    'SpriteObjectData' : _initSprite,
    'ImageViewObjectData' : _initImageView,
    'ParticleObjectData' : _initParticle,
    'GameMapObjectData' : _initTiledMap,
    'SimpleAudioObjectData' : _initAudio,
    'ButtonObjectData' : _initButton,
    'TextBMFontObjectData' : _initLabel,
    'TextObjectData' : _initLabel,
    'LoadingBarObjectData' : _initProgressBar,
    'TextFieldObjectData' : _initEditBox,
    'PanelObjectData' : _initPanel,
    'CheckBoxObjectData' : _initCheckbox,
    'TextAtlasObjectData' : _initTextAtlas,
    'SliderObjectData' : _initSilderbar,
    'ListViewObjectData' : _initListView,
    'PageViewObjectData' : _initPageView
};

const nodeCreators = {
    'ProjectNodeObjectData' : _createProjectNode,
    'ScrollViewObjectData' : _createScrollView
};

const notInitBasePropTypes = [
    'GameLayerObjectData',
    'GameNodeObjectData'
];

const actionPropsParser = {
    'AnchorPoint': _parseAnchor,
    'Position' : _parsePosition,
    'RotationSkew' : _parseRotation,
    'Scale' : _parseScale,
    'CColor' : _parseColor,
    'Alpha' : _parseOpacity,
    'VisibleForFrame' : _parseVisible,
    //'BlendFunc' : _parseBlend,        // TODO not support blend action now
    'FileData' : _parseFileData
};

const easePrefixTypes = [
    'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'elastic', 'back', 'bounce'
];

const easeSuffixTypes = [
    'In', 'Out', 'InOut'
];

const DEFAULT_FRAME_EVENT_CALL_FUN = 'triggerAnimationEvent';

var importedCSDFiles = [];
var resRootUrl = '';
var resTempPath = '';
var resRootPath = ''; // the root path of resources in studio project

var actTag2NodePath = {};

function importCSDFiles(csdFiles, baseResPath, tempResPath, targetRootUrl, cb) {
    resRootPath = baseResPath;
    resTempPath = tempResPath;
    resRootUrl = targetRootUrl;

    var index = 0;
    Async.whilst(
        function(cb) {
            cb(null, index < csdFiles.length);
        },
        function(callback) {
            _importCSDFile(csdFiles[index], function() {
                index++;
                callback();
            });
        },
        function () {
            cb();
        }
    );
}

function _importCSDFile(csdFilePath, cb) {
    if (importedCSDFiles.indexOf(csdFilePath) >= 0) {
        cb();
        return;
    }
    Editor.log('Importing csd file : ', csdFilePath);

    if (!Fs.existsSync(csdFilePath)) {
        Editor.warn('%s is not existed!', csdFilePath);
        cb();
        return;
    }

    var state = Fs.statSync(csdFilePath);
    if (!state.isFile()) {
        Editor.warn('%s is not a file!', csdFilePath);
        cb();
        return;
    }

    var doc = new DOMParser().parseFromString(Fs.readFileSync(csdFilePath, 'utf-8'));
    if (!doc) {
        Editor.warn('Parse %s failed.', csdFilePath);
        cb();
        return;
    }

    try {
        // get csd property
        var propertyGroup = doc.getElementsByTagName('PropertyGroup')[0];
        var csdType = propertyGroup.getAttribute('Type');

        // get node data
        var content = doc.getElementsByTagName('Content')[0];
        content = XmlUtils.getFirstChildNodeByName(content, 'Content');
    } catch (err) {
        Editor.warn('Parse %s failed.', csdFilePath);
        cb();
        return;
    }

    if (!content || !csdType) {
        Editor.warn('Parse %s failed.', csdFilePath);
        cb();
        return;
    }

    // get the temp path & creator method
    var tempPath = null;
    var useFunc = null;
    switch (csdType) {
        case 'Scene':
            tempPath = _genTempPath(csdFilePath, '.fire');
            useFunc = _createSceneFromData;
            break;
        case 'Node':
        case 'Layer':
            tempPath = _genTempPath(csdFilePath, '.prefab');
            useFunc = _createPrefabFromData;
            break;
    }

    if (!useFunc) {
        cb();
        return;
    }

    Async.waterfall([
        function (next) {
            // clean the recorded action Tag data
            actTag2NodePath = {};

            // generate the file data
            useFunc(content, csdFilePath, function(targetFileData) {
                // write the data to file
                if (targetFileData) {
                    var targetFolder = Path.dirname(tempPath);
                    if (!Fs.existsSync(targetFolder)) {
                        Fs.mkdirsSync(targetFolder);
                    }
                    Fs.writeFileSync(tempPath, targetFileData);
                }
                next();
            });
        },
        function(next) {
            var relativePath = Path.relative(resTempPath, tempPath);
            var targetUrl = Url.join(resRootUrl, relativePath);
            Editor.assetdb.import([tempPath], Url.dirname(targetUrl), false, function (err, results) {
                importedCSDFiles.push(csdFilePath);
                next();
            });
        }
    ], cb);
}

function _genTempPath(csdPath, urlExtname) {
    var folderPath = Path.dirname(csdPath);
    var relativePath = Path.relative(resRootPath, folderPath);
    var csdName = Path.basename(csdPath, Path.extname(csdPath));
    return Path.join(resTempPath, relativePath, csdName + urlExtname);
}

function _genActionTempPath(csdPath) {
    var folderPath = Path.dirname(csdPath);
    var relativePath = Path.relative(resRootPath, folderPath);
    var csdName = Path.basename(csdPath, Path.extname(csdPath));

    var folderName = csdName + ACTION_FOLDER_SUFFIX;
    var checkUrl = Url.join(resRootUrl, relativePath, folderName);
    // var i = 1;
    // while (Fs.existsSync(Editor.assetdb.remote._fspath(checkUrl))) {
    //     folderName = csdName + ACTION_FOLDER_SUFFIX + i;
    //     checkUrl = Url.join(resRootUrl, relativePath, folderName);
    //     i++;
    // }

    return Path.join(resTempPath, relativePath, folderName);
}

function _genImportedCSDUrl(csdPath, urlExtname) {
    var folderPath = Path.dirname(csdPath);
    var relativePath = Path.relative(resRootPath, folderPath);
    var csdName = Path.basename(csdPath, Path.extname(csdPath));
    return Url.join(resRootUrl, relativePath, csdName + urlExtname);
}

function _checkNodeName(name) {
    var newName = name;
    if (name) {
        newName = name.replace(PATH_SEPERATOR, '_');
        if (newName !== name) {
            Editor.warn('The name of node "%s" contains illegal characters. It was renamed to "%s".', name, newName);
        }
    }

    return newName;
}

function _createSceneFromData(contentData, csdFilePath, cb) {
    var assetObj = new cc.SceneAsset();
    var sceneNode = new cc.Scene();
    var rootNode = new cc.Node('Scene');
    rootNode.setAnchorPoint(0, 0);
    sceneNode.addChild(rootNode);

    // add canvas
    var canvasNode = new cc.Node('Canvas');
    canvasNode.addComponent(cc.Canvas);
    rootNode.addChild(canvasNode);

    // add camera
    var cameraNode = new cc.Node('Main Camera');
    cameraNode.addComponent(cc.Camera);
    canvasNode.addChild(cameraNode);

    _createData(rootNode, contentData, csdFilePath, function() {
        assetObj.scene = sceneNode;
        cb(Editor.serialize(assetObj));
    });
}

function _createPrefabFromData(contentData, csdFilePath, cb) {
    var rootNode = new cc.Node();

    _createData(rootNode, contentData, csdFilePath, function() {
        let PrefabUtils = Editor.require('scene://utils/prefab');
        var prefab = PrefabUtils.createPrefabFrom(rootNode);
        cb(Editor.serialize(prefab));
    });
}

function _createData(node, contentData, csdFilePath, cb) {
    Async.waterfall([
        function(next) {
            var nodeData = XmlUtils.getFirstChildNodeByName(contentData, 'ObjectData');
            _createNodeGraph(node, nodeData, '', function() {
                next();
            });
        },
        function(next) {
            _createAnimationClips(node, contentData, csdFilePath, next);
        }
    ], cb);
}

// ---------- Animation related methods ----------
function _createAnimationClips(node, contentData, csdFilePath, cb) {
    var animationData = XmlUtils.getFirstChildNodeByName(contentData, 'Animation');
    if (!animationData) {
        // no animation data
        cb();
        return;
    }

    var timelineNodes = XmlUtils.getChildNodesByName(animationData, 'Timeline');
    if (!timelineNodes || timelineNodes.length === 0) {
        // no animation data
        cb();
        return;
    }

    // create the temp path for animations
    var actionTempPath = _genActionTempPath(csdFilePath);
    if (!Fs.existsSync(actionTempPath)) {
        Fs.mkdirsSync(actionTempPath);
    }

    // get information of animations
    var maxFrame = XmlUtils.getIntPropertyOfNode(animationData, 'Duration', 0);
    var speed = XmlUtils.getFloatPropertyOfNode(animationData, 'Speed', 0);

    // generate animation list information
    var defaultActionName = Path.basename(csdFilePath, Path.extname(csdFilePath));
    var actListInfo = [
        {
            'name' : defaultActionName,
            'startIndex' : 0,
            'endIndex' : maxFrame
        }
    ];
    var i = 0, n = 0;
    var animationListData = XmlUtils.getFirstChildNodeByName(contentData, 'AnimationList');
    if (animationListData) {
        var actListItems = XmlUtils.getChildNodesByName(animationListData, 'AnimationInfo');
        if (actListItems && actListItems.length > 0) {
            var firstNameIdx = 1;
            for (i = 0, n = actListItems.length; i < n; i++) {
                var item = actListItems[i];
                var actName = XmlUtils.getPropertyOfNode(item, 'Name', '');
                if (actName) {
                    if (actName.toLowerCase() === actListInfo[0].name.toLowerCase()) {
                        // make sure the whole action name is not used
                        actListInfo[0].name = defaultActionName + firstNameIdx;
                        firstNameIdx++;
                    }
                    var startIdx = XmlUtils.getIntPropertyOfNode(item, 'StartIndex', 0);
                    var endIdx = XmlUtils.getIntPropertyOfNode(item, 'EndIndex', maxFrame);
                    actListInfo.push({
                        'name' : actName,
                        'startIndex' : startIdx,
                        'endIndex' : endIdx
                    });
                }
            }
        }
    }

    // parse animation data
    var actionsInfo = {};
    var actionEvents = [];
    for (i = 0, n = timelineNodes.length; i < n; i++) {
        var timelineNode = timelineNodes[i];
        var actTag = XmlUtils.getPropertyOfNode(timelineNode, 'ActionTag', '');
        var nodeInfo = actTag2NodePath[actTag];
        if (!nodeInfo) {
            continue;
        }
        var nodePath = nodeInfo.nodePath;
        if (!nodePath) {
            continue;
        }

        var prop = XmlUtils.getPropertyOfNode(timelineNode, 'Property', '');
        if (prop === 'FrameEvent') {
            actionEvents = _parseFrameEvent(timelineNode, actionEvents);
        }
        else {
            var propParser = actionPropsParser[prop];
            if (!propParser && prop !== '') {
                Editor.warn('Action for property "%s" is not supported.', prop);
                continue;
            }
            actionsInfo[nodePath] = propParser(timelineNode, actionsInfo[nodePath], nodeInfo.node);
        }
    }

    var parentPath = Path.dirname(actionTempPath);
    var relativeFolder = Path.relative(resTempPath, parentPath);
    var targetUrl = Url.join(resRootUrl, relativeFolder);
    var importedUrls = [];

    // write animation data to files
    for (i = 0, n = actListInfo.length; i < n; i++) {
        var info = actListInfo[i];
        var targetFileName = info.name + '.anim';
        var targetFilePath = Path.join(actionTempPath, targetFileName);
        var animClip = _genAnimationClip(info, actionsInfo, actionEvents);
        animClip.speed = speed;
        animClip.sample = DEFAULT_ACTION_FPS;
        animClip._name = info.name;
        animClip._duration = (info.endIndex - info.startIndex) / DEFAULT_ACTION_FPS;
        var animClipStr = Editor.serialize(animClip);
        Fs.writeFileSync(targetFilePath, animClipStr);

        importedUrls.push(Url.join(targetUrl, Path.basename(actionTempPath), targetFileName));
    }

    Async.waterfall([
        function(next) {
            // import animation files to assets
            Editor.assetdb.import([actionTempPath], targetUrl, false, function() {
                next();
            });
        },
        function(next) {
            // add animation component for the node
            var animateComponent = node.addComponent(cc.Animation);
            if (!animateComponent) {
                Editor.warn('Add Animation component failed.');
                next();
            } else {
                // set properties for animation component
                for (i = 0, n = importedUrls.length; i < n; i++) {
                    var clipUrl = importedUrls[i];
                    var uuid = Editor.assetdb.remote.urlToUuid(clipUrl);
                    if (!uuid) {
                        continue;
                    }

                    var animClip = new cc.AnimationClip();
                    animClip._uuid = uuid;
                    animClip._name = Url.basenameNoExt(clipUrl);
                    animateComponent.addClip(animClip);
                }
                next();
            }
        }
    ], cb);
}

function _genAnimationClip(actItemInfo, wholeActionsData, wholeActionsEvent) {
    var animClip = new cc.AnimationClip();
    var startIdx = actItemInfo.startIndex;
    var endIdx = actItemInfo.endIndex;

    var pathsInfo = {};
    for (var nodePath in wholeActionsData) {
        if (!wholeActionsData.hasOwnProperty(nodePath)) {
            continue;
        }

        var nodeInfo = {};
        var wholeNodeInfo = wholeActionsData[nodePath];

        // generate the props information
        var wholePropsInfo = wholeNodeInfo.props;
        if (wholePropsInfo) {
            var nodePropsInfo = {};
            for (var prop in wholePropsInfo) {
                if (!wholePropsInfo.hasOwnProperty(prop)) {
                    continue;
                }
                nodePropsInfo[prop] = _genRightFrames(wholePropsInfo[prop], startIdx, endIdx);
            }
            nodeInfo.props = nodePropsInfo;
        }

        // generate the comps information
        var wholeCompsInfo = wholeNodeInfo.comps;
        if (wholeCompsInfo) {
            var nodeCompsInfo = null;
            for (var comp in wholeCompsInfo) {
                if (!wholeCompsInfo.hasOwnProperty(comp)) {
                    continue;
                }

                var compData = null;
                var wholeCompData = wholeCompsInfo[comp];
                for (var compProp in wholeCompData) {
                    if (!wholeCompData.hasOwnProperty(compProp)) {
                        continue;
                    }

                    var compPropFrames = _genRightFrames(wholeCompData[compProp], startIdx, endIdx);
                    if (compPropFrames.length > 0) {
                        if (!compData) {
                            compData = {};
                        }
                        compData[compProp] = compPropFrames;
                    }
                }

                if (compData) {
                    if (!nodeCompsInfo) {
                        nodeCompsInfo = {};
                    }
                    nodeCompsInfo[comp] = compData;
                }
            }

            if (nodeCompsInfo) {
                nodeInfo.comps = nodeCompsInfo;
            }
        }

        pathsInfo[nodePath] = nodeInfo;
    }

    animClip.curveData = { 'paths' : pathsInfo };
    animClip.events = _genRightFrames(wholeActionsEvent, startIdx, endIdx);
    return animClip;
}

function _genRightFrames(allFrames, startIndex, endIndex) {
    var frames = [];
    for (var i = 0, n = allFrames.length; i < n; i++) {
        let frame = allFrames[i];
        let frameIdx = frame.frame;
        if (frameIdx < startIndex || frameIdx > endIndex) {
            continue;
        }

        let newFrame = {};
        for (var frameProp in frame) {
            if (!frame.hasOwnProperty(frameProp)) {
                continue;
            }

            if (frameProp === 'frame') {
                newFrame.frame = (frameIdx - startIndex) / DEFAULT_ACTION_FPS;
            } else {
                newFrame[frameProp] = frame[frameProp];
            }
        }
        frames.push(newFrame);
    }

    return frames;
}

function _checkActionPropInfo(nodeActionInfo) {
    if (!nodeActionInfo) {
        nodeActionInfo = {};
    }

    if (!nodeActionInfo.props) {
        nodeActionInfo.props = {};
    }

    return nodeActionInfo;
}

function _checkActionCompInfo(nodeActionInfo, componetName) {
    if (!nodeActionInfo) {
        nodeActionInfo = {};
    }

    if (!nodeActionInfo.comps) {
        nodeActionInfo.comps = {};
    }

    if (!nodeActionInfo.comps[componetName]) {
        nodeActionInfo.comps[componetName] = {};
    }

    return nodeActionInfo;
}

function _getEasingData(frameData) {
    var easeType = XmlUtils.getIntPropertyOfNode(frameData, 'Type', 0, 'EasingData');
    if (easeType === 0) {
        return null;
    }

    var ret = null;
    if (easeType === -1) {
        // custom easing type
        var easingData = XmlUtils.getFirstChildNodeByName(frameData, 'EasingData');
        var pointsData = XmlUtils.getFirstChildNodeByName(easingData, 'Points');
        var points = XmlUtils.getChildNodesByName(pointsData, 'PointF');
        var x1 = XmlUtils.getFloatPropertyOfNode(points[1], 'X', '0');
        var y1 = XmlUtils.getFloatPropertyOfNode(points[1], 'Y', '0');
        var x2 = XmlUtils.getFloatPropertyOfNode(points[2], 'X', '0');
        var y2 = XmlUtils.getFloatPropertyOfNode(points[2], 'Y', '0');
        ret = [ x1, y1, x2, y2 ];
    } else {
        var prefixIdx = Math.floor((easeType - 1) / 3);
        var suffixIdx = (easeType - 1) % 3;
        if (prefixIdx < easePrefixTypes.length) {
            ret = easePrefixTypes[prefixIdx] + easeSuffixTypes[suffixIdx];
        }
    }

    return ret;
}

function _parseAnchor(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var anchorXInfo = [];
    var anchorYInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var x = XmlUtils.getFloatPropertyOfNode(frameData, 'X', 0);
        var y = XmlUtils.getFloatPropertyOfNode(frameData, 'Y', 0);
        var frameAnchorX = {
            'frame' : frameIdx,
            'value' : x
        };
        var frameAnchorY = {
            'frame' : frameIdx,
            'value' : y
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            frameAnchorX.curve = easeData;
            frameAnchorY.curve = easeData;
        }
        anchorXInfo.push(frameAnchorX);
        anchorYInfo.push(frameAnchorY);
    }

    nodeActionInfo.props.anchorX = anchorXInfo;
    nodeActionInfo.props.anchorY = anchorYInfo;
    return nodeActionInfo;
}

function _parsePosition(timelineNode, nodeActionInfo, nodeObj) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var posInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var x = XmlUtils.getFloatPropertyOfNode(frameData, 'X', 0);
        var y = XmlUtils.getFloatPropertyOfNode(frameData, 'Y', 0);

        // convert the position to the new coordinate system of creator
        // TODO Should consider the anchor point moved on parent during the frameIdx changed.
        var pos = _convertNodePos(nodeObj, cc.v2(x, y));
        var framePos = {
            'frame' : frameIdx,
            'value' : [
                pos.x, pos.y
            ]
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            framePos.curve = easeData;
        }
        posInfo.push(framePos);
    }

    nodeActionInfo.props.position = posInfo;
    return nodeActionInfo;
}

function _parseRotation(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var rotateInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var rotateValue = XmlUtils.getFloatPropertyOfNode(frameData, 'X', 0);
        var frameRotate = {
            'frame' : frameIdx,
            'value' : rotateValue
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            frameRotate.curve = easeData;
        }
        rotateInfo.push(frameRotate);
    }

    nodeActionInfo.props.rotation = rotateInfo;
    return nodeActionInfo;
}

function _parseScale(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var scaleXInfo = [];
    var scaleYInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var x = XmlUtils.getFloatPropertyOfNode(frameData, 'X', 0);
        var y = XmlUtils.getFloatPropertyOfNode(frameData, 'Y', 0);
        var frameScaleX = {
            'frame' : frameIdx,
            'value' : x
        };
        var frameScaleY = {
            'frame' : frameIdx,
            'value' : y
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            frameScaleX.curve = easeData;
            frameScaleY.curve = easeData;
        }
        scaleXInfo.push(frameScaleX);
        scaleYInfo.push(frameScaleY);
    }
    nodeActionInfo.props.scaleX = scaleXInfo;
    nodeActionInfo.props.scaleY = scaleYInfo;
    return nodeActionInfo;
}

function _parseColor(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var colorInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var frameColor = {
            'frame' : frameIdx,
            'value' : new cc.Color(XmlUtils.getIntPropertyOfNode(frameData, 'R', 255, 'Color'),
                XmlUtils.getIntPropertyOfNode(frameData, 'G', 255, 'Color'),
                XmlUtils.getIntPropertyOfNode(frameData, 'B', 255, 'Color'), 255)
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            frameColor.curve = easeData;
        }
        colorInfo.push(frameColor);
    }
    nodeActionInfo.props.color = colorInfo;
    return nodeActionInfo;
}

function _parseOpacity(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var opacityInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var frameOpacity = {
            'frame' : frameIdx,
            'value' : XmlUtils.getIntPropertyOfNode(frameData, 'Value', 255)
        };

        var easeData = _getEasingData(frameData);
        if (easeData) {
            frameOpacity.curve = easeData;
        }
        opacityInfo.push(frameOpacity);
    }
    nodeActionInfo.props.opacity = opacityInfo;
    return nodeActionInfo;
}

function _parseVisible(timelineNode, nodeActionInfo) {
    nodeActionInfo = _checkActionPropInfo(nodeActionInfo);
    var visibleInfo = [];
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        var frameVisible = {
            'frame' : frameIdx,
            'value' : XmlUtils.getBoolPropertyOfNode(frameData, 'Value', true)
        };

        visibleInfo.push(frameVisible);
    }
    nodeActionInfo.props.active = visibleInfo;
    return nodeActionInfo;
}

function _parseFrameEvent (timelineNode, actionEvents) {
    var frames = XmlUtils.getAllChildren(timelineNode);
    for (var i = 0, n = frames.length; i < n; i++) {
        var frameData = frames[i];
        var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
        // 这里统一触发自定义的一个函数，然后把帧事件定义的字符串当做参数传入
        var param = XmlUtils.getPropertyOfNode(frameData, 'Value', '');
        var frameVisible = {
            'frame' : frameIdx,
            'func': DEFAULT_FRAME_EVENT_CALL_FUN,
        };
        if (param) {
            frameVisible['params'] = [
                param
            ]
        }

        actionEvents.push(frameVisible);
    }
    return actionEvents;
}

function _parseBlend(timelineNode, nodeActionInfo, nodeObj) {
    if (!nodeObj) {
        return nodeActionInfo;
    }

    // TODO add blend factor action data for node

    return nodeActionInfo;
}

function _parseFileData(timelineNode, nodeActionInfo, nodeObj) {
    if (!nodeObj) {
        return nodeActionInfo;
    }

    var sp = nodeObj.getComponent(cc.Sprite);
    if (sp) {
        var compName = 'cc.Sprite';
        nodeActionInfo = _checkActionCompInfo(nodeActionInfo, compName);
        var spFramePropInfo = [];
        var frames = XmlUtils.getAllChildren(timelineNode);
        for (var i = 0, n = frames.length; i < n; i++) {
            var frameData = frames[i];
            var frameIdx = XmlUtils.getIntPropertyOfNode(frameData, 'FrameIndex', 0);
            var textureData = XmlUtils.getFirstChildNodeByName(frameData, 'TextureFile');
            var spFrame = _getSpriteFrame(textureData, '');
            if (!spFrame) {
                continue;
            }

            var frame = {
                'frame' : frameIdx,
                'value' : spFrame
            };
            spFramePropInfo.push(frame);
        }

        nodeActionInfo.comps[compName]['spriteFrame'] = spFramePropInfo;
    }

    return nodeActionInfo;
}

// ---------- NodeGraph related methods ----------
function _createNodeGraph(rootNode, nodeData, parentNodePath, cb) {
    var cbNode = rootNode;
    var needRecordActTag = false;
    var curNodePath = '';
    Async.waterfall([
        function(next) {
            if (!rootNode) {
                needRecordActTag = true;
                var nodeType = nodeData.getAttribute('ctype');

                var creator = nodeCreators[nodeType];
                if (creator) {
                    creator(nodeData, function(newNode, returnNode) {
                        rootNode = newNode;
                        cbNode = returnNode ? returnNode : rootNode;
                        next();
                    });
                } else {
                    rootNode = new cc.Node();
                    cbNode = rootNode;
                    next();
                }
            } else {
                next();
            }
        },
        function(next) {
            if (needRecordActTag) {
                var actTag = XmlUtils.getPropertyOfNode(nodeData, 'ActionTag', '');
                if (actTag) {
                    if (parentNodePath) {
                        curNodePath += (parentNodePath + '/');
                    }
                    curNodePath += _checkNodeName(nodeData.getAttribute('Name'));
                    actTag2NodePath[actTag] = {
                        'nodePath' : curNodePath,
                        'node' : cbNode
                    };
                }
            }
            _initNode(rootNode, nodeData, next);
        },
        function(next) {
            // loop in the Children
            var childrenElement = nodeData.getElementsByTagName('Children');
            if (!childrenElement || childrenElement.length === 0) {
                next();
                return;
            }

            childrenElement = childrenElement[0];
            var childrenData = childrenElement.childNodes;
            var children = [];
            for (var i = 0, n = childrenData.length; i < n; i++) {
                var childData = childrenData[i];
                if (XmlUtils.shouldIgnoreNode(childData)) {
                    continue;
                }
                children.push(childData);
            }

            if (children.length === 0) {
                next();
                return;
            }

            var index = 0;
            Async.whilst(
                function(cb) {
                    cb(null, index < children.length);
                },
                function(callback) {
                    _createNodeGraph(null, children[index], curNodePath, function(newNode) {
                        rootNode.addChild(newNode);
                        // adjust the position of the child node
                        if (newNode.getParent()) {
                            newNode.setPosition(_convertNodePos(newNode));
                        }
                        index++;
                        callback();
                    });
                },
                function() {
                    next();
                }
            )
        }
    ], function() {
        cb(cbNode);
    });
}

function _convertNodePos(node, curPos) {
    if (!curPos) {
        curPos = node.getPosition();
    }

    var parent = node.getParent();
    if (!parent) {
        return curPos;
    }

    var parentAnchor = parent.getAnchorPoint();
    var parentSize = parent.getContentSize();
    var newX = curPos.x - parentSize.width * parentAnchor.x;
    var newY = curPos.y - parentSize.height * parentAnchor.y;
    return cc.v2(newX, newY);
}

function _initBaseProperties(node, nodeData) {
    var nodeType = nodeData.getAttribute('ctype');
    node.setName(_checkNodeName(nodeData.getAttribute('Name')));
    node.setContentSize(XmlUtils.getFloatPropertyOfNode(nodeData, 'X', 0, 'Size'),
                        XmlUtils.getFloatPropertyOfNode(nodeData, 'Y', 0, 'Size'));

    if (nodeType === 'GameLayerObjectData') {
        node.setAnchorPoint(0, 0);
    }

    if (notInitBasePropTypes.indexOf(nodeType) < 0) {
        node.active = XmlUtils.getBoolPropertyOfNode(nodeData, 'VisibleForFrame', true);
        node.setAnchorPoint(XmlUtils.getFloatPropertyOfNode(nodeData, 'ScaleX', 0, 'AnchorPoint'),
                            XmlUtils.getFloatPropertyOfNode(nodeData, 'ScaleY', 0, 'AnchorPoint'));
        node.setPosition(XmlUtils.getFloatPropertyOfNode(nodeData, 'X', 0, 'Position'),
                         XmlUtils.getFloatPropertyOfNode(nodeData, 'Y', 0, 'Position'));
        var scaleX = XmlUtils.getFloatPropertyOfNode(nodeData, 'ScaleX', 1.0, 'Scale');
        var scaleY = XmlUtils.getFloatPropertyOfNode(nodeData, 'ScaleY', 1.0, 'Scale');
        var flipX = XmlUtils.getBoolPropertyOfNode(nodeData, 'FlipX', false);
        var flipY = XmlUtils.getBoolPropertyOfNode(nodeData, 'FlipY', false);
        scaleX = flipX ? (scaleX * -1): scaleX;
        scaleY = flipY ? (scaleY * -1): scaleY;
        node.setScale(scaleX, scaleY);
        let rotationX = XmlUtils.getFloatPropertyOfNode(nodeData, 'RotationSkewX', 0);
        let rotationY = XmlUtils.getFloatPropertyOfNode(nodeData, 'RotationSkewY', 0);
        if (rotationX === rotationY) {
            node.angle = rotationX;
        }
        else {
            node.is3DNode = true;
            node.eulerAngles = cc.v3(rotationX, rotationY, 0);
        }

        // EditBox & ScrollView should not set the node color
        if (nodeType !== 'TextFieldObjectData' &&
            nodeType !== 'ScrollViewObjectData') {
            node.color = new cc.Color(
                XmlUtils.getIntPropertyOfNode(nodeData, 'R', 255, 'CColor'),
                XmlUtils.getIntPropertyOfNode(nodeData, 'G', 255, 'CColor'),
                XmlUtils.getIntPropertyOfNode(nodeData, 'B', 255, 'CColor')
            );
            node.opacity = XmlUtils.getIntPropertyOfNode(nodeData, 'Alpha', 255);
        }
    }
}

function _initNode(node, nodeData, cb) {
    var nodeType = nodeData.getAttribute('ctype');

    // ScrollView should not init the base properties of the node
    if (nodeType !== 'ScrollViewObjectData') {
        _initBaseProperties(node, nodeData);
    }

    node.active = XmlUtils.getBoolPropertyOfNode(nodeData, 'VisibleForFrame', true);

    // TouchEnable is true, Add an intercept click event
    let touchEnable = XmlUtils.getBoolPropertyOfNode(nodeData, 'TouchEnable', false);
    if (touchEnable) {
        node.addComponent(cc.BlockInputEvents);
    }

    // add widget component if necessary
    _addWidget(node, nodeData);

    // init the node with data of specified type
    if (nodeType && nodeImporters[nodeType]) {
        nodeImporters[nodeType](node, nodeData, cb);
    } else {
        cb();
    }
}

function _addWidget(node, nodeData) {
    var hEdge = XmlUtils.getPropertyOfNode(nodeData, 'HorizontalEdge', '');
    var percentWidthEnable = XmlUtils.getBoolPropertyOfNode(nodeData, 'PercentWidthEnable', false);
    var percentWidthEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'PercentWidthEnabled', false);
    var positionPercentXEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'PositionPercentXEnabled', false);
    var stretchWidthEnable = XmlUtils.getBoolPropertyOfNode(nodeData, 'StretchWidthEnable', false);
    var posPercentX = XmlUtils.getFloatPropertyOfNode(nodeData, 'X', 0, 'PrePosition');
    if (positionPercentXEnabled) {
        positionPercentXEnabled = posPercentX !== 0;
    }

    var vEdge = XmlUtils.getPropertyOfNode(nodeData, 'VerticalEdge', '');
    var percentHeightEnable = XmlUtils.getBoolPropertyOfNode(nodeData, 'PercentHeightEnable', false);
    var percentHeightEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'PercentHeightEnabled', false);
    var positionPercentYEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'PositionPercentYEnabled', false);
    var stretchHeightEnable = XmlUtils.getBoolPropertyOfNode(nodeData, 'StretchHeightEnable', false);
    var posPercentY = XmlUtils.getFloatPropertyOfNode(nodeData, 'Y', 0, 'PrePosition');

    if (positionPercentYEnabled) {
        positionPercentYEnabled = posPercentY !== 0;
    }

    var needWidget = !!hEdge || percentWidthEnable || percentWidthEnabled || positionPercentXEnabled || stretchWidthEnable ||
        !!vEdge || percentHeightEnable || percentHeightEnabled || positionPercentYEnabled || stretchHeightEnable;
    if (!needWidget) {
        return;
    }

    var widget = node.addComponent(cc.StudioWidget);
    if (!widget) {
        Editor.warn('Add Widget component for node %s failed.', nodeData.getAttribute('Name'));
        return;
    }

    var anchorPos = node.getAnchorPoint();
    var widthPercent = XmlUtils.getFloatPropertyOfNode(nodeData, 'X', 0, 'PreSize');
    var leftMargin = XmlUtils.getFloatPropertyOfNode(nodeData, 'LeftMargin', 0);
    var rightMargin = XmlUtils.getFloatPropertyOfNode(nodeData, 'RightMargin', 0);
    var leftPercent = (posPercentX - widthPercent * anchorPos.x);
    var rightPercent = (1 - posPercentX - widthPercent * (1 - anchorPos.x));

    function alignLeft(isAbsolute) {
        widget.isAlignLeft = true;
        widget.isAbsoluteLeft = isAbsolute;
        widget.left = isAbsolute ? leftMargin : leftPercent;
    }

    function alignRight(isAbsolute) {
        widget.isAlignRight = true;
        widget.isAbsoluteRight = isAbsolute;
        widget.right = isAbsolute ? rightMargin : rightPercent;
    }

    var usePercentWidth = percentWidthEnable || percentWidthEnabled || stretchWidthEnable;
    if (hEdge.indexOf('Left') >= 0) {
        alignLeft(!positionPercentXEnabled);
        if (usePercentWidth) {
            alignRight(false);
        }
    }
    else if (hEdge.indexOf('Right') >= 0) {
        alignRight(!positionPercentXEnabled);
        if (usePercentWidth) {
            alignLeft(false);
        }
    }
    else if (hEdge.indexOf('Both') >= 0) {
        alignLeft(!usePercentWidth && !positionPercentXEnabled);
        alignRight(!usePercentWidth && !positionPercentXEnabled);
    }
    else if (usePercentWidth) {
        alignLeft(false);
        alignRight(false);
    }
    else {
        if (positionPercentXEnabled) {
            alignLeft(false);
        }
    }

    var heightPercent = XmlUtils.getFloatPropertyOfNode(nodeData, 'Y', 0, 'PreSize');
    var topMargin = XmlUtils.getFloatPropertyOfNode(nodeData, 'TopMargin', 0);
    var bottomMargin = XmlUtils.getFloatPropertyOfNode(nodeData, 'BottomMargin', 0);
    var bottomPercent = (posPercentY - heightPercent * anchorPos.y);
    var topPercent = (1 - posPercentY - heightPercent * (1 - anchorPos.y));

    function alignBottom(isAbsolute) {
        widget.isAlignBottom = true;
        widget.isAbsoluteBottom = isAbsolute;
        widget.bottom = isAbsolute ? bottomMargin : bottomPercent;
    }

    function alignTop(isAbsolute) {
        widget.isAlignTop = true;
        widget.isAbsoluteTop = isAbsolute;
        widget.top = isAbsolute ? topMargin : topPercent;
    }

    var usePercentHeight = percentHeightEnable || percentHeightEnabled || stretchHeightEnable;
    if (vEdge.indexOf('Bottom') >= 0) {
        alignBottom(!positionPercentYEnabled);
        if (usePercentHeight) {
            alignTop(false);
        }
    }
    else if (vEdge.indexOf('Top') >= 0) {
        alignTop(!positionPercentYEnabled);
        if (usePercentHeight) {
            alignBottom(false);
        }
    }
    else if (vEdge.indexOf('Both') >= 0) {
        alignBottom(!usePercentHeight && !positionPercentYEnabled);
        alignTop(!usePercentHeight && !positionPercentYEnabled);
    }
    else {
        if (positionPercentYEnabled) {
            alignBottom(false);
        }
    }
}

function _getSpriteFrameUuid (fileDataNode, defaultUrl) {
    // using default sprite image
    var retUrl = defaultUrl;
    if (fileDataNode) {
        var fileType = XmlUtils.getPropertyOfNode(fileDataNode, 'Type', 'Default');
        var filePath = XmlUtils.getPropertyOfNode(fileDataNode, 'Path', '');
        switch (fileType) {
            case 'PlistSubImage':
                // using image in plist file
                var plistPath = XmlUtils.getPropertyOfNode(fileDataNode, 'Plist', '');
                if (plistPath && filePath) {
                    var plistUrl = Url.join(resRootUrl, plistPath);
                    retUrl = Url.join(plistUrl, filePath.replace(PATH_SEPERATOR, '-'));
                }
                break;
            case 'MarkedSubImage':
            // using image in csi file, treat as normal
            case 'Normal':
                // using normal image file
                if (filePath) {
                    retUrl = Url.join(resRootUrl, filePath);
                    retUrl = Url.join(retUrl, Url.basenameNoExt(retUrl));
                }
                break;
        }
    }
    let uuid = Editor.assetdb.remote.urlToUuid(retUrl);
    if (!retUrl || !uuid) {
        return null;
    }
    return uuid;
}

function _getSpriteFrame(fileDataNode, defaultUrl) {
    if (!fileDataNode && !defaultUrl) {
        return null;
    }
    let uuid = _getSpriteFrameUuid(fileDataNode, defaultUrl);
    if (!uuid) {
        Editor.warn('Failed to import spriteframe asset, asset info: ' + fileDataNode + ', uuid: ' + uuid);
        return null;
    }
    if (!Editor.assetdb.remote.existsByUuid(uuid)) {
        Editor.warn('Failed to import spriteframe asset, asset info: ' + fileDataNode + ', url: ' + defaultUrl);
        return null;
    }
    var frame = new cc.SpriteFrame();
    frame._uuid = uuid;
    return frame;
}

function _setScale9Properties(nodeData, uuid, cb) {
    Editor.assetdb.queryMetaInfoByUuid(uuid, function(err,info) {
        if (!info) {
            cb();
            return;
        }

        // modify the meta info
        var meta = JSON.parse(info.json);

        var dataX = XmlUtils.getIntPropertyOfNode(nodeData, 'Scale9OriginX', 0);
        var dataY = XmlUtils.getIntPropertyOfNode(nodeData, 'Scale9OriginY', 0);
        var dataWidth = XmlUtils.getIntPropertyOfNode(nodeData, 'Scale9Width', meta.rawWidth);
        var dataHeight = XmlUtils.getIntPropertyOfNode(nodeData, 'Scale9Height', meta.rawHeight);

        meta.trimThreshold = -1;
        meta.borderTop = dataY;
        meta.borderBottom = meta.rawHeight - dataY - dataHeight;
        if (meta.borderBottom < 0) {
            meta.borderBottom = 0;
        }
        meta.borderLeft = dataX;
        meta.borderRight = meta.rawWidth - dataX - dataWidth;
        if (meta.borderRight < 0) {
            meta.borderRight = 0;
        }

        var jsonString = JSON.stringify(meta);

        // 现在内置资源不支持修改
        if (info.assetUrl.startsWith(INTERNAL)) {
            cb();
        }
        else {
            Editor.assetdb.saveMeta( uuid, jsonString, function() {
                cb();
            });
        }
    });
}

function _initSprite(node, nodeData, cb) {
    // add a sprite component
    _initSpriteWithSizeMode(node, nodeData, cc.Sprite.SizeMode.RAW, cb);
}

function _initSpriteWithSizeMode(node, nodeData, sizeMode, cb) {
    var sp = node.addComponent(cc.Sprite);
    if (!sp) {
        Editor.warn('Add sprite component for node %s failed.', nodeData.getAttribute('Name'));
        return cb;
    }

    // init blend function
    var srcBlend = XmlUtils.getIntPropertyOfNode(nodeData, 'Src', cc.macro.BlendFactor.SRC_ALPHA, 'BlendFunc');
    sp.srcBlendFactor = (srcBlend === 1 ? cc.macro.BlendFactor.SRC_ALPHA : srcBlend);
    sp.dstBlendFactor = XmlUtils.getIntPropertyOfNode(nodeData, 'Dst', cc.macro.BlendFactor.ONE_MINUS_SRC_ALPHA, 'BlendFunc');

    // init file data
    var fileDataNode = XmlUtils.getFirstChildNodeByName(nodeData, 'FileData');
    sp.sizeMode = sizeMode;
    sp.trim = false;
    sp.spriteFrame = _getSpriteFrame(fileDataNode, '');
    cb();
}

function _initImageView(node, nodeData, cb) {
    Async.waterfall([
        function(next) {
            _initSpriteWithSizeMode(node, nodeData, cc.Sprite.SizeMode.CUSTOM, next);
        },
        function(next) {
            var sp = node.getComponent(cc.Sprite);
            if (!sp) {
                next();
                return;
            }

            // init 9scale properties for the sprite frame
            var sp9ScaleEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'Scale9Enable', false);
            if (sp9ScaleEnabled && sp.spriteFrame) {
                sp.type = cc.Sprite.Type.SLICED;
                _setScale9Properties(nodeData, sp.spriteFrame._uuid, next);
            } else {
                next();
            }
        }
    ], cb);
}

function _initParticle(node, nodeData, cb) {
    var par = node.addComponent(cc.ParticleSystem);
    if (!par) {
        Editor.warn('Add ParticleSystem component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init file data
    var fileType = XmlUtils.getPropertyOfNode(nodeData, 'Type', 'Default', 'FileData');
    var plistUrl = '';
    switch(fileType) {
        case 'Normal':
            var filePath = XmlUtils.getPropertyOfNode(nodeData, 'Path', '', 'FileData');
            plistUrl = Url.join(resRootUrl, filePath);
            break;
        case 'Default':
        default:
            plistUrl = DEFAULT_PARTICLE_URL;
            break;
    }

    if (plistUrl) {
        var uuid = Editor.assetdb.remote.urlToUuid(plistUrl);
        if (Editor.assetdb.remote.existsByUuid(uuid)) {
            par.file = Editor.assetdb.remote._fspath(plistUrl);
            par.custom = false;
        }
    }

    cb();
}

function _initTiledMap(node, nodeData, cb) {
    var map = node.addComponent(cc.TiledMap);
    if (!map) {
        Editor.warn('Add TiledMap component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init file data
    var fileType = XmlUtils.getPropertyOfNode(nodeData, 'Type', 'Default', 'FileData');
    var tmxUrl = '';
    switch(fileType) {
        case 'Normal':
            var filePath = XmlUtils.getPropertyOfNode(nodeData, 'Path', '', 'FileData');
            tmxUrl = Url.join(resRootUrl, filePath);
            break;
        case 'Default':
        default:
            break;
    }

    if (tmxUrl) {
        var uuid = Editor.assetdb.remote.urlToUuid(tmxUrl);
        if (Editor.assetdb.remote.existsByUuid(uuid)) {
            map.tmxFile = Editor.assetdb.remote._fspath(tmxUrl);
        }
    }

    cb();
}

function _initAudio(node, nodeData, cb) {
    var audio = node.addComponent(cc.AudioSource);
    if (!audio) {
        Editor.warn('Add AudioSource component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init file data
    var fileType = XmlUtils.getPropertyOfNode(nodeData, 'Type', 'Default', 'FileData');
    var audioUrl = '';
    switch(fileType) {
        case 'Normal':
            var filePath = XmlUtils.getPropertyOfNode(nodeData, 'Path', '', 'FileData');
            audioUrl = Url.join(resRootUrl, filePath);
            break;
        case 'Default':
        default:
            break;
    }

    if (audioUrl) {
        var uuid = Editor.assetdb.remote.urlToUuid(audioUrl);
        if (Editor.assetdb.remote.existsByUuid(uuid)) {
            audio.clip = Editor.assetdb.remote._fspath(audioUrl);
        }
    }

    cb();
}

function _initButton(node, nodeData, cb) {
    var btn = node.addComponent(cc.Button);
    var sp = node.addComponent(cc.Sprite);
    if (!btn) {
        Editor.warn('Add Button component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init the property of sprite component
    sp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    sp.trim = false;
    var scale9Enabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'Scale9Enable', false);
    if (scale9Enabled) {
        sp.type = cc.Sprite.Type.SLICED;
    }

    // set the button enable/disable
    btn.interactable = XmlUtils.getBoolPropertyOfNode(nodeData, 'DisplayState', true);

    // init the sprite frame
    btn.transition = cc.Button.Transition.SPRITE;
    var normalCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'NormalFileData');
    sp.spriteFrame = _getSpriteFrame(normalCfg, DEFAULT_BTN_NORMAL_URL);
    btn.normalSprite = _getSpriteFrame(normalCfg, DEFAULT_BTN_NORMAL_URL);
    btn.hoverSprite = _getSpriteFrame(normalCfg, DEFAULT_BTN_NORMAL_URL);

    var pressedCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'PressedFileData');
    btn.pressedSprite = _getSpriteFrame(pressedCfg, DEFAULT_BTN_PRESSED_URL);

    var disabledCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'DisabledFileData');
    btn.disabledSprite = _getSpriteFrame(disabledCfg, DEFAULT_BTN_DISABLED_URL);

    // add a label child
    var btnText = XmlUtils.getPropertyOfNode(nodeData, 'ButtonText', '');
    if (btnText) {
        var labelNode = new cc.Node('Label');
        labelNode.setContentSize(node.getContentSize());
        node.addChild(labelNode);
        var label = labelNode.addComponent(cc.Label);
        var fontSize = XmlUtils.getIntPropertyOfNode(nodeData, 'FontSize', 14);
        var txtColor = new cc.Color(XmlUtils.getIntPropertyOfNode(nodeData, 'R', 65, 'TextColor'),
            XmlUtils.getIntPropertyOfNode(nodeData, 'G', 65, 'TextColor'),
            XmlUtils.getIntPropertyOfNode(nodeData, 'B', 70, 'TextColor'));
        var txtOpacity = XmlUtils.getIntPropertyOfNode(nodeData, 'A', 255, 'TextColor');
        labelNode.color = txtColor;
        labelNode.opacity = txtOpacity;
        label.string = btnText;
        label._fontSize = fontSize;
        label.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
        label.verticalAlign = cc.Label.VerticalAlign.CENTER;

        var widget = labelNode.addComponent(cc.StudioWidget);
        widget.isAlignVerticalCenter = true;
        widget.isAlignHorizontalCenter = true;

        var fntResCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'FontResource');
        if (fntResCfg) {
            _setFntFileForLabel(label, fntResCfg);
        }
    }

    // implement 9Scale properties
    if (scale9Enabled) {
        var spFrames = [ btn.normalSprite, btn.pressedSprite, btn.disabledSprite ];
        var uuids = [];
        for (var i = 0, n = spFrames.length; i < n; i++) {
            var frame = spFrames[i];
            if (!frame) {
                continue;
            }

            if (uuids.indexOf(frame._uuid) < 0) {
                uuids.push(frame._uuid);
            }
        }

        if (uuids.length === 0) {
            cb();
            return;
        }

        var index = 0;
        Async.whilst(
            function(cb) {
                cb(null, index < uuids.length);
            },
            function(callback) {
                _setScale9Properties(nodeData, uuids[index], function () {
                    index++;
                    callback();
                });
            },
            function() {
                cb();
            }
        );
    } else {
        cb();
    }
}

function _initLabel(node, nodeData, cb) {
    var label = node.addComponent(cc.Label);
    if (!label) {
        Editor.warn('Add Label component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    var isCustomSize = XmlUtils.getBoolPropertyOfNode(nodeData, 'IsCustomSize', false);
    if (isCustomSize) {
        label.overflow = cc.Label.Overflow.CLAMP;
        label._useOriginalSize = false;
    }

    // init text
    label.string = XmlUtils.getPropertyOfNode(nodeData, 'LabelText', '');
    label.lineHeight = 0;

    // set the alignment
    var hAlign = XmlUtils.getPropertyOfNode(nodeData, 'HorizontalAlignmentType', '');
    switch (hAlign) {
        case 'HT_Right':
            label.horizontalAlign = cc.Label.HorizontalAlign.RIGHT;
            break;
        case 'HT_Center':
            label.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
            break;
        default:
            label.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
            break;
    }

    var vAlign = XmlUtils.getPropertyOfNode(nodeData, 'VerticalAlignmentType', '');
    switch (vAlign) {
        case 'VT_Bottom':
            label.verticalAlign = cc.Label.VerticalAlign.BOTTOM;
            break;
        case 'VT_Center':
            label.verticalAlign = cc.Label.VerticalAlign.CENTER;
            break;
        default:
            label.verticalAlign = cc.Label.VerticalAlign.TOP;
            break;
    }

    var bmfntCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'LabelBMFontFile_CNB');
    var fntResCfg = XmlUtils.getFirstChildNodeByName(nodeData, 'FontResource');
    Async.waterfall([
        function(next) {
            // init fnt properties
            if (bmfntCfg) {
                // BMFont
                _setFntFileForLabel(label, bmfntCfg, next);
            }
            else if (fntResCfg) {
                // ttf font
                _setFntFileForLabel(label, fntResCfg, next);
            } else {
                next();
            }
        },
        function(next) {
            var fontSize = XmlUtils.getIntPropertyOfNode(nodeData, 'FontSize', -1);
            if (fontSize >= 0) {
                label._fontSize = fontSize;
                next();
            } else if (bmfntCfg) {

                _loaderFntAsset(bmfntCfg, (err, font) => {
                    if (err || !font) { next(); }
                    var config = font._fntConfig;
                    label._fontSize = config.fontSize;
                    label.lineHeight = config.commonHeight;
                    next();
                });

            } else {
                next();
            }
        }
    ], cb);
}

function _loaderFntAsset (fntCfg, cb) {
    var fntFileUrl = Url.join(resRootUrl, XmlUtils.getPropertyOfNode(fntCfg, 'Path', ''));
    var needLoadFnt = false;
    if (fntFileUrl) {
        var fntUuid = Editor.assetdb.remote.urlToUuid(fntFileUrl);
        if (Editor.assetdb.remote.existsByUuid(fntUuid)) {
            needLoadFnt = true;
        }
    }

    if (needLoadFnt) {
        cc.assetManager.loadAny(fntUuid, cb);
    } else {
        cb && cb(null, null);
    }
}

function _setFntFileForLabel(label, fntCfg, cb) {
    if (!label || !fntCfg) {
        if (cb) {
            cb();
        }
        return;
    }

    _loaderFntAsset(fntCfg, (err, font) => {
        if (err) {
            Editor.error(err);
        }
        label.font = font || null;
        cb && cb();
    });
}

function _initProgressBar(node, nodeData, cb) {
    var bar = node.addComponent(cc.Sprite);
    var progress = node.addComponent(cc.ProgressBar);
    if (!progress) {
        Editor.warn('Add ProgressBar component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init progress bar properties
    progress.mode = cc.ProgressBar.Mode.FILLED;
    var reverseCfg = XmlUtils.getPropertyOfNode(nodeData, 'ProgressType', '');
    progress.reverse = (reverseCfg === 'Right_To_Left');

    bar.sizeMode =cc.Sprite.SizeMode.CUSTOM;
    bar.trim = false;
    var fileDataNode = XmlUtils.getFirstChildNodeByName(nodeData, 'ImageFileData');
    bar.spriteFrame = _getSpriteFrame(fileDataNode, DEFAULT_PROGRESSBAR_URL);
    bar.type = cc.Sprite.Type.FILLED;
    bar.fillType = cc.Sprite.FillType.HORIZONTAL;
    bar.fillStart = progress.reverse ? 1 : 0;
    progress.barSprite = bar;

    // set the total length & current progress
    progress.totalLength = 1;
    var progressInfo = XmlUtils.getIntPropertyOfNode(nodeData, 'ProgressInfo', 80);
    progress.progress = progressInfo / 100;

    cb();
}

function _initEditBox(node, nodeData, cb) {
    var edit = node.addComponent(cc.EditBox);
    if (!edit) {
        Editor.warn('Add EditBox component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    // init EditBox properties
    edit._useOriginalSize = false;
    edit.lineHeight = 0;
    edit.placeholder = XmlUtils.getPropertyOfNode(nodeData, 'PlaceHolderText', '');
    edit.string = XmlUtils.getPropertyOfNode(nodeData, 'LabelText', '');
    edit.fontColor = new cc.Color(XmlUtils.getIntPropertyOfNode(nodeData, 'R', 255, 'CColor'),
                                  XmlUtils.getIntPropertyOfNode(nodeData, 'G', 255, 'CColor'),
                                  XmlUtils.getIntPropertyOfNode(nodeData, 'B', 255, 'CColor'),
                                  XmlUtils.getIntPropertyOfNode(nodeData, 'A', 255, 'CColor'));
    edit.fontSize = XmlUtils.getIntPropertyOfNode(nodeData, 'FontSize', 20);
    var maxEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'MaxLengthEnable', false);
    if (maxEnabled) {
        edit.maxLength = XmlUtils.getIntPropertyOfNode(nodeData, 'MaxLengthText', 10);
    } else {
        edit.maxLength = -1;
    }

    if (XmlUtils.getBoolPropertyOfNode(nodeData, 'PasswordEnable', false)) {
        edit.inputFlag = cc.EditBox.InputFlag.PASSWORD;
        edit.inputMode = cc.EditBox.InputMode.SINGLE_LINE;
    }

    cb();
}

function _initPanel(node, nodeData, cb) {
    var clipAble = XmlUtils.getBoolPropertyOfNode(nodeData, 'ClipAble', false);
    if (clipAble) {
        var mask = node.addComponent(cc.Mask);
        mask.enabled = true;
    }

    _addContainerBack(node, nodeData, cb);
}

function _initCheckbox(node, nodeData, cb) {
    var studio = node.addComponent(cc.StudioComponent);
    if (!studio) {
        Editor.warn('Add StudioComponent component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    studio.type = cc.StudioComponent.ComponentType.CHECKBOX;
    var normalBackFileData = XmlUtils.getFirstChildNodeByName(nodeData, 'NormalBackFileData');
    studio.checkNormalBackFrame = _getSpriteFrame(normalBackFileData, '');
    var pressedBackFileData = XmlUtils.getFirstChildNodeByName(nodeData, 'PressedBackFileData');
    studio.checkPressedBackFrame = _getSpriteFrame(pressedBackFileData, '');
    var disableBackFileData = XmlUtils.getFirstChildNodeByName(nodeData, 'DisableBackFileData');
    studio.checkDisableBackFrame = _getSpriteFrame(disableBackFileData, '');
    var nodeNormalFileData = XmlUtils.getFirstChildNodeByName(nodeData, 'NodeNormalFileData');
    studio.checkNormalFrame = _getSpriteFrame(nodeNormalFileData, '');
    var nodeDisableFileData = XmlUtils.getFirstChildNodeByName(nodeData, 'NodeDisableFileData');
    studio.checkDisableFrame = _getSpriteFrame(nodeDisableFileData, '');
    studio.checkInteractable = XmlUtils.getBoolPropertyOfNode(nodeData, 'DisplayState', true);
    studio.isChecked = XmlUtils.getBoolPropertyOfNode(nodeData, 'CheckedState', false);

    cb();
}

function _initTextAtlas(node, nodeData, cb) {
    var studio = node.addComponent(cc.StudioComponent);
    if (!studio) {
        Editor.warn('Add StudioComponent component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    studio.type = cc.StudioComponent.ComponentType.TEXT_ATLAS;
    var atlasFrameData = XmlUtils.getFirstChildNodeByName(nodeData, 'LabelAtlasFileImage_CNB');
    studio.atlasFrame = _getSpriteFrame(atlasFrameData, '');
    studio.firstChar = XmlUtils.getPropertyOfNode(nodeData, 'StartChar', '.');
    studio.charWidth = XmlUtils.getIntPropertyOfNode(nodeData, 'CharWidth', 0);
    studio.charHeight = XmlUtils.getIntPropertyOfNode(nodeData, 'CharHeight', 0);
    studio.string = XmlUtils.getPropertyOfNode(nodeData, 'LabelText', '');
    cb();
}

function _initSilderbar(node, nodeData, cb) {
    var studio = node.addComponent(cc.StudioComponent);
    if (!studio) {
        Editor.warn('Add StudioComponent component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    studio.type = cc.StudioComponent.ComponentType.SLIDER_BAR;
    var backGroundData = XmlUtils.getFirstChildNodeByName(nodeData, 'BackGroundData');
    studio.sliderBackFrame = _getSpriteFrame(backGroundData, '');
    var progressBarData = XmlUtils.getFirstChildNodeByName(nodeData, 'ProgressBarData');
    studio.sliderBarFrame = _getSpriteFrame(progressBarData, '');
    var ballNormalData = XmlUtils.getFirstChildNodeByName(nodeData, 'BallNormalData');
    studio.sliderBtnNormalFrame = _getSpriteFrame(ballNormalData, '');
    var ballPressedData = XmlUtils.getFirstChildNodeByName(nodeData, 'BallPressedData');
    studio.sliderBtnPressedFrame = _getSpriteFrame(ballPressedData, '');
    var ballDisabledData = XmlUtils.getFirstChildNodeByName(nodeData, 'BallDisabledData');
    studio.sliderBtnDisabledFrame = _getSpriteFrame(ballDisabledData, '');
    studio.sliderInteractable = XmlUtils.getBoolPropertyOfNode(nodeData, 'DisplayState', true);
    var percent = XmlUtils.getIntPropertyOfNode(nodeData, 'PercentInfo', 0);
    studio.sliderProgress = percent / 100;
    cb();
}

function _initListView(node, nodeData, cb) {
    var studio = node.addComponent(cc.StudioComponent);
    if (!studio) {
        Editor.warn('Add StudioComponent component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    studio.type = cc.StudioComponent.ComponentType.LIST_VIEW;
    studio.listInertia = XmlUtils.getBoolPropertyOfNode(nodeData, 'IsBounceEnabled', false);
    var dir = XmlUtils.getPropertyOfNode(nodeData, 'DirectionType', '');
    if (dir === 'Vertical') {
        studio.listDirection = cc.StudioComponent.ListDirection.VERTICAL;
        let alignType = XmlUtils.getPropertyOfNode(nodeData, 'HorizontalType', 'Left');
        if (alignType.indexOf('Center') >= 0) {
            studio.listHorizontalAlign = cc.StudioComponent.HorizontalAlign.CENTER;
        }
        else if (alignType.indexOf('Right') >= 0) {
            studio.listHorizontalAlign = cc.StudioComponent.HorizontalAlign.RIGHT;
        }
        else {
            studio.listHorizontalAlign = cc.StudioComponent.HorizontalAlign.LEFT;
        }
    } else {
        studio.listDirection = cc.StudioComponent.ListDirection.HORIZONTAL;
        let alignType = XmlUtils.getPropertyOfNode(nodeData, 'VerticalType', 'Top');
        if (alignType.indexOf('Center') >= 0) {
            studio.listVerticalAlign = cc.StudioComponent.VerticalAlign.CENTER;
        }
        else if (alignType.indexOf('Bottom') >= 0) {
            studio.listVerticalAlign = cc.StudioComponent.VerticalAlign.BOTTOM;
        }
        else {
            studio.listVerticalAlign = cc.StudioComponent.VerticalAlign.TOP;
        }
    }
    studio.listPadding = XmlUtils.getIntPropertyOfNode(nodeData, 'ItemMargin', 0);
    _initPanel(node, nodeData, cb);
}

function _initPageView(node, nodeData, cb) {
    var studio = node.addComponent(cc.StudioComponent);
    if (!studio) {
        Editor.warn('Add StudioComponent component for node %s failed.', nodeData.getAttribute('Name'));
        cb();
        return;
    }

    studio.type = cc.StudioComponent.ComponentType.PAGE_VIEW;
    _initPanel(node, nodeData, cb);
}

function _createProjectNode(nodeData, cb) {
    var filePath = XmlUtils.getPropertyOfNode(nodeData, 'Path', '', 'FileData');
    var csdPath = Path.join(resRootPath, filePath);
    var newNode = null;
    Async.waterfall([
        function(next) {
            // import the csd file as a prefab
            _importCSDFile(csdPath, next);
        },
        function(next) {
            // create a node with imported prefab
            var prefabUrl = _genImportedCSDUrl(csdPath, '.prefab');
            var uuid = Editor.assetdb.remote.urlToUuid(prefabUrl);
            if (!uuid) {
                next();
                return;
            }
            cc.assetManager.loadAny(uuid, function (err, prefab) {
                if (err) {
                    next();
                } else {
                    newNode = cc.instantiate(prefab);
                    next();
                }
            });
        }
    ], function() {
        if (!newNode) {
            newNode = new cc.Node();
        }
        cb(newNode);
    });
}

function _createScrollView(nodeData, cb) {
    var scrollNode = new cc.Node(_checkNodeName(nodeData.getAttribute('Name')));
    _initBaseProperties(scrollNode, nodeData);
    var scroll = scrollNode.addComponent(cc.ScrollView);
    if (!scroll) {
        Editor.warn('Add ScrollView component for node %s failed.', nodeData.getAttribute('Name'));
        cb(scrollNode);
        return;
    }

    scroll.inertia = XmlUtils.getBoolPropertyOfNode(nodeData, 'IsBounceEnabled', false);
    var scrollDir = XmlUtils.getPropertyOfNode(nodeData, 'ScrollDirectionType', 'Vertical');
    scroll.vertical = (scrollDir.indexOf('Vertical') >= 0);
    scroll.horizontal = (scrollDir.indexOf('Horizontal') >= 0);

    // add Mask component if necessary
    var clipAble = XmlUtils.getBoolPropertyOfNode(nodeData, 'ClipAble', false);
    if (clipAble) {
        var mask = scrollNode.addComponent(cc.Mask);
        mask.enabled = true;
    }

    // create content node
    var scrollViewWidth = scrollNode.getContentSize().width;
    var scrollViewHeight = scrollNode.getContentSize().height;
    var contentNode = new cc.Node('content');
    var contentWidth = XmlUtils.getIntPropertyOfNode(nodeData, 'Width', scrollViewWidth, 'InnerNodeSize');
    var contentHeight = XmlUtils.getIntPropertyOfNode(nodeData, 'Height', scrollViewHeight, 'InnerNodeSize');
    contentNode.setContentSize(contentWidth, contentHeight);
    contentNode.setAnchorPoint(0, 1);
    contentNode.setPosition(0, scrollViewHeight);

    Async.waterfall([
        function(next) {
            // add background node
            _addContainerBack(scrollNode, nodeData, next);
        },
        function(next) {
            // add content node
            scrollNode.addChild(contentNode);
            contentNode.setPosition(_convertNodePos(contentNode));
            scroll.content = contentNode;

            // add scrollbar
            if (scroll.vertical) {
                var vScrollBarNode = _genScrollBar(cc.Scrollbar.Direction.VERTICAL, 'vScrollBar', scrollNode.getContentSize());
                scrollNode.addChild(vScrollBarNode);
                scroll.verticalScrollBar = vScrollBarNode.getComponent(cc.Scrollbar);
            }
            if (scroll.horizontal) {
                var hScrollBarNode = _genScrollBar(cc.Scrollbar.Direction.HORIZONTAL, 'hScrollBar', scrollNode.getContentSize());
                scrollNode.addChild(hScrollBarNode);
                scroll.horizontalScrollBar = hScrollBarNode.getComponent(cc.Scrollbar);
            }
            next();
        }
    ], function() {
        cb(contentNode, scrollNode);
    });
}

function _addContainerBack(container, nodeData, cb) {
    var containerWidth = container.getContentSize().width;
    var containerHeight = container.getContentSize().height;
    var fileData = XmlUtils.getFirstChildNodeByName(nodeData, 'FileData');
    var backComboIndex = XmlUtils.getIntPropertyOfNode(nodeData, 'ComboBoxIndex', 0);
    var backNode = null;

    Async.waterfall([
        function(next) {
            if (fileData) {
                backNode = new cc.Node('background');
                let backSp = backNode.addComponent(cc.Sprite);
                backSp.trim = false;
                var frame = _getSpriteFrame(fileData, DEFAULT_PANEL_URL);
                if (!frame) {
                    return next();
                }
                var scaleEnabled = XmlUtils.getBoolPropertyOfNode(nodeData, 'Scale9Enable', false);
                if (scaleEnabled) {
                    backNode.setContentSize(container.getContentSize());
                    backSp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
                    backSp.type = cc.Sprite.Type.SLICED;
                    backSp.spriteFrame = frame;
                    _setScale9Properties(nodeData, frame._uuid, next);
                } else {
                    backSp.spriteFrame = frame;
                    next();
                }
            }
            else if (backComboIndex === 1) {
                backNode = new cc.Node('background');
                backNode.setContentSize(containerWidth, containerHeight);
                let backSp = backNode.addComponent(cc.Sprite);
                backSp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
                backSp.trim = false;
                backSp.spriteFrame = new cc.SpriteFrame();
                backSp.spriteFrame._uuid = Editor.assetdb.remote.urlToUuid(DEFAULT_SPLASH_SP_URL);
                backNode.color = new cc.Color(
                    XmlUtils.getIntPropertyOfNode(nodeData, 'R', 255, 'SingleColor'),
                    XmlUtils.getIntPropertyOfNode(nodeData, 'G', 255, 'SingleColor'),
                    XmlUtils.getIntPropertyOfNode(nodeData, 'B', 255, 'SingleColor')
                );
                backNode.opacity = XmlUtils.getIntPropertyOfNode(nodeData, 'BackColorAlpha', 255);
                next();
            } else {
                next();
            }
        },
        function(next) {
            if (backNode) {
                container.addChild(backNode);
                let widget = backNode.addComponent(cc.StudioWidget);
                widget.isAlignHorizontalCenter = true;
                widget.isAlignVerticalCenter = true;
            }
            next();
        }
    ], cb);
}

function _genScrollBar(direction, name, viewSize) {
    var retNode = new cc.Node(name);
    var scrollbar = retNode.addComponent(cc.Scrollbar);
    scrollbar.direction = direction;

    var widget = retNode.addComponent(cc.StudioWidget);
    widget.isAlignRight = true;
    widget.isAlignBottom = true;
    widget.isAlignTop = (direction === cc.Scrollbar.Direction.VERTICAL);
    widget.isAlignLeft = (direction === cc.Scrollbar.Direction.HORIZONTAL);

    var barNode = new cc.Node('bar');
    retNode.addChild(barNode);
    var barSp = barNode.addComponent(cc.Sprite);
    barSp.type = cc.Sprite.Type.SLICED;
    barSp.trim = false;
    barSp.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    barSp.spriteFrame = new cc.SpriteFrame();
    if (direction === cc.Scrollbar.Direction.HORIZONTAL) {
        retNode.setContentSize(viewSize.width, 15);
        barNode.setContentSize(viewSize.width * 0.7, 15);
        barSp.spriteFrame._uuid = Editor.assetdb.remote.urlToUuid(DEFAULT_HSCROLLBAR_URL);
    } else {
        retNode.setContentSize(15, viewSize.height);
        barNode.setContentSize(15, viewSize.height * 0.7);
        barSp.spriteFrame._uuid = Editor.assetdb.remote.urlToUuid(DEFAULT_VSCROLLBAR_URL);
    }
    scrollbar.handle = barSp;

    return retNode;
}

module.exports = {
    importCSDFiles: importCSDFiles,
};
