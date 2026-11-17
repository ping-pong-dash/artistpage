function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var root = props.getProperty('ROOT_FOLDER_ID')
      ? DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'))
      : DriveApp.getFolderById('1ObCpREIQIO_UZ64P_s-4fM-O364gx7s0');
    props.setProperty('ROOT_FOLDER_ID', root.getId());
    if (!props.getProperty('IMAGES_FOLDER_ID')) props.setProperty('IMAGES_FOLDER_ID', root.createFolder('images').getId());
    if (!props.getProperty('HISTORY_FOLDER_ID')) props.setProperty('HISTORY_FOLDER_ID', root.createFolder('history').getId());
    if (!props.getProperty('SHARED_SECRET')) props.setProperty('SHARED_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
    console.log('Drive folder: ' + root.getUrl());
    console.log('Setup complete. SHARED_SECRET is in Project Settings > Script properties.');
  } finally { lock.releaseLock(); }
}

function doGet() {
  return output_({ ok: false, status: 405, message: 'Signed POST requests only.' });
}

function doPost(event) {
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SHARED_SECRET');
    if (!secret || !props.getProperty('IMAGES_FOLDER_ID')) throw error_(503, 'Googleドライブの初期設定を完了してください。');
    var outer = JSON.parse(event.postData.contents);
    if (typeof outer.message !== 'string' || outer.message.length > 4000000) throw error_(400, 'Invalid request.');
    var digest = hex_(Utilities.computeHmacSha256Signature(outer.message, secret));
    if (!equal_(outer.signature, digest)) throw error_(403, 'Signature mismatch.');
    var request = JSON.parse(outer.message);
    if (!Number.isFinite(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 5 * 60 * 1000) throw error_(403, 'Request expired.');
    var payload = request.payload || {};
    var result;
    if (request.action === 'read') result = { content: readContent_() };
    else if (request.action === 'save') result = saveContent_(payload);
    else if (request.action === 'upload') result = uploadImage_(payload);
    else if (request.action === 'image') result = readImage_(payload.key);
    else throw error_(400, 'Unknown action.');
    return output_({ ok: true, data: result });
  } catch (error) {
    return output_({ ok: false, status: error.httpStatus || 502, message: error.httpStatus ? error.message : 'Googleドライブの操作に失敗しました。容量とApps Scriptの実行履歴を確認してください。' });
  }
}

function readContent_() {
  var props = PropertiesService.getScriptProperties();
  var fileId = props.getProperty('CONTENT_FILE_ID');
  if (!fileId) return null;
  var file = DriveApp.getFileById(fileId);
  assertParent_(file, props.getProperty('HISTORY_FOLDER_ID'));
  return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
}

function saveContent_(payload) {
  if (!payload.data || !payload.data.memberData || !payload.data.liveData || !payload.data.albums) throw error_(400, 'Invalid content.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw error_(503, 'ほかの保存処理が実行中です。少し待って再保存してください。');
  try {
    var current = readContent_();
    if ((current ? current.revision : null) !== payload.expectedRevision) throw error_(409, 'ほかのメンバーの更新があります。下書きを書き出してから再読み込みしてください。');
    var content = {
      schemaVersion: 1,
      revision: Utilities.getUuid(),
      updatedAt: new Date().toISOString(),
      data: payload.data
    };
    var serialized = JSON.stringify(content);
    if (serialized.length > 3000000) throw error_(413, '投稿データが大きすぎます。');
    var props = PropertiesService.getScriptProperties();
    var folder = DriveApp.getFolderById(props.getProperty('HISTORY_FOLDER_ID'));
    // Publish only after the complete snapshot exists; retain every previous snapshot.
    var file = folder.createFile(Utilities.newBlob(serialized, 'application/json', content.updatedAt.replace(/:/g, '-') + '_' + content.revision + '.json'));
    props.setProperty('CONTENT_FILE_ID', file.getId());
    return { revision: content.revision, updatedAt: content.updatedAt };
  } finally { lock.releaseLock(); }
}

function uploadImage_(payload) {
  if (!/^[a-f0-9]{64}$/.test(payload.key || '') || !['image/jpeg', 'image/png', 'image/webp'].includes(payload.mime)) throw error_(400, 'Invalid image.');
  var bytes = Utilities.base64Decode(payload.base64);
  if (bytes.length > 2560000 || hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)) !== payload.key) throw error_(400, 'Image size or checksum mismatch.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw error_(503, '画像保存が混み合っています。少し待って再保存してください。');
  try {
    var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('IMAGES_FOLDER_ID'));
    if (!folder.getFilesByName(payload.key).hasNext()) folder.createFile(Utilities.newBlob(bytes, payload.mime, payload.key));
    return { key: payload.key };
  } finally { lock.releaseLock(); }
}

function readImage_(key) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw error_(400, 'Invalid image ID.');
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('IMAGES_FOLDER_ID'));
  var files = folder.getFilesByName(key);
  if (!files.hasNext()) throw error_(404, '写真が見つかりません。');
  var blob = files.next().getBlob();
  return { base64: Utilities.base64Encode(blob.getBytes()) };
}

function assertParent_(file, folderId) {
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return;
  throw error_(403, 'File is outside the website folder.');
}

function output_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function error_(status, message) { var error = new Error(message); error.httpStatus = status; return error; }
function hex_(bytes) { return bytes.map(function(byte) { return ((byte + 256) % 256).toString(16).padStart(2, '0'); }).join(''); }
function equal_(left, right) {
  if (typeof left !== 'string' || left.length !== right.length) return false;
  var result = 0;
  for (var i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}
