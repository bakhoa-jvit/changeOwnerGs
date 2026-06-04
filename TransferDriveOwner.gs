/**
 * ============================================================================
 *  Drive Ownership Transfer Tool — Web App + CLI
 *  Quet 1 folder Drive va tat ca folder con + file ben trong, tim cac item do
 *  nguoi dang chay script so huu, roi chuyen owner / gui yeu cau chuyen owner
 *  cho email moi.
 *
 *  KHA THI NHUNG CO GIOI HAN QUAN TRONG:
 *   - Chi ap dung cho item trong My Drive ma nguoi chay dang la owner.
 *   - Khong ho tro Shared drives: file trong Shared drive thuoc ve to chuc/drive.
 *   - Google Workspace cung domain: co the transfer truc tiep bang Drive API.
 *   - Gmail/consumer: owner moi phai chap nhan; script chi tao pending owner.
 *   - Folder khong tu dong doi owner tat ca con; script phai quet va xu ly tung item.
 *
 *  Can bat Advanced Google service: Drive API.
 * ============================================================================
 */

// ========================= CLI CONFIG =========================================
var CLI_NEW_OWNER_EMAIL = 'new_owner@gmail.com';
var CLI_FOLDER_ID       = 'DAN_ID_FOLDER_VAO_DAY';
var CLI_DIRECT_TRANSFER = false; // true = Workspace cung domain; false = Gmail/pending owner
var CLI_DRY_RUN         = true;
// ==============================================================================

var TRANSFER_MAX_RUNTIME_MS = 5 * 60 * 1000;
var TRANSFER_PROPS_KEY = 'TRANSFER_OWNER_STATE';
var TRANSFER_STATE_FILE_ID_KEY = 'TRANSFER_OWNER_STATE_FILE_ID';
var TRANSFER_ACTIVE_JOB_ID_KEY = 'TRANSFER_OWNER_ACTIVE_JOB_ID';
var TRANSFER_PAUSED_JOB_ID_KEY = 'TRANSFER_OWNER_PAUSED_JOB_ID';
var TRANSFER_RESET_JOB_ID_KEY = 'TRANSFER_OWNER_RESET_JOB_ID';
var TRANSFER_CONTINUE_FUNC = 'continueOwnershipTransfer';
var TRANSFER_SAVE_EVERY = 25;
var TRANSFER_SAVE_EVERY_MS = 3000;
var TRANSFER_MAX_LOG_LINES = 200;
var TRANSFER_DRIVE_LIST_PAGE_SIZE = 1000;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Drive Ownership Transfer Tool')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function startOwnershipTransfer(newOwnerEmail, folderId, directTransfer) {
  newOwnerEmail = (newOwnerEmail || '').trim().toLowerCase();
  folderId = (folderId || '').trim();
  directTransfer = !!directTransfer;

  if (!newOwnerEmail) throw new Error('Email owner moi khong duoc de trong.');
  if (newOwnerEmail.indexOf('@') === -1) throw new Error('Email owner moi khong hop le.');
  if (!folderId) throw new Error('Folder ID khong duoc de trong.');

  try {
    DriveApp.getFolderById(folderId).getName();
  } catch (e) {
    throw new Error('Khong tim thay folder hoac ban khong co quyen truy cap.');
  }

  var existingState = _transferLoadState();
  if (_transferCanResumeExistingJob(existingState, newOwnerEmail, folderId, directTransfer)) {
    existingState.updatedAt = new Date().toISOString();
    existingState.waitingForResume = existingState.status === 'awaiting_confirm' ? false : !!existingState.waitingForResume;
    _transferProps().setProperty(TRANSFER_ACTIVE_JOB_ID_KEY, existingState.jobId);
    _transferLog(existingState, '▶ Tim thay checkpoint cung Email + Folder ID. Tiep tuc tu lan chay truoc...');
    _transferSaveState(existingState);
    return { ok: true, jobId: existingState.jobId, resumed: true };
  }

  _transferDeleteTrigger();
  _transferDeleteCheckpoint();
  _transferProps().deleteProperty(TRANSFER_RESET_JOB_ID_KEY);

  var state = {
    jobId: Utilities.getUuid(),
    newOwnerEmail: newOwnerEmail,
    rootId: folderId,
    directTransfer: directTransfer,
    phase: 'scan',
    queue: [folderId],
    visited: {},
    scannedIds: {},
    matches: [],
    transferIndex: 0,
    resumePhase: '',
    stats: { scanned: 0, owned: 0, eligible: 0, pending: 0, transferred: 0, requested: 0, skipped: 0, failed: 0 },
    pass: 1,
    status: 'scanning',
    logs: [],
    logOffset: 0,
    logSeq: 0,
    waitingForResume: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  _transferProps().setProperty(TRANSFER_ACTIVE_JOB_ID_KEY, state.jobId);
  _transferLog(state, '▶ Dung Drive API de doc owner va permissions. Hay bat Services (+) > Drive API.');
  _transferLog(state, directTransfer
    ? '▶ Che do: transfer truc tiep. Phu hop Google Workspace cung domain.'
    : '▶ Che do: gui yeu cau pending owner. Phu hop Gmail/consumer; nguoi nhan phai chap nhan.');
  _transferSaveState(state);
  return { ok: true, jobId: state.jobId };
}

function getOwnershipTransferProgress() {
  var state = _transferLoadState();
  if (!state) {
    return { status: 'idle', stats: { scanned: 0, owned: 0, eligible: 0, pending: 0, transferred: 0, requested: 0, skipped: 0, failed: 0 }, logs: [], pass: 1 };
  }
  return {
    status: state.status,
    phase: state.phase,
    jobId: state.jobId || '',
    stats: state.stats,
    logs: state.logs || [],
    logOffset: state.logOffset || 0,
    logSeq: state.logSeq || ((state.logOffset || 0) + ((state.logs || []).length)),
    pass: state.pass || 1,
    updatedAt: state.updatedAt || '',
    matchCount: state.matches ? state.matches.length : 0,
    transferIndex: state.transferIndex || 0,
    pendingTransfer: state.matches ? state.matches.length - (state.transferIndex || 0) : 0,
    directTransfer: !!state.directTransfer,
    resumePhase: state.resumePhase || '',
    waitingForResume: !!state.waitingForResume
  };
}

function confirmOwnershipTransfer() {
  var state = _transferLoadState();
  if (!state) throw new Error('Khong co ket qua quet de xac nhan.');
  if (state.status === 'paused' && state.matches && state.matches.length > (state.transferIndex || 0)) {
    state.resumePhase = state.phase === 'transfer' ? '' : (state.resumePhase || 'scan');
  } else if (state.status !== 'awaiting_confirm') {
    throw new Error('Job chua san sang de chuyen owner.');
  }

  state.phase = 'transfer';
  state.status = 'transferring';
  state.transferIndex = state.transferIndex || 0;
  state.updatedAt = new Date().toISOString();
  _transferLog(state, '▶ Da xac nhan. Bat dau xu ly ' + ((state.matches || []).length - state.transferIndex) + ' item...');
  _transferSaveState(state);
  return { ok: true };
}

function continueScanOnly() {
  var state = _transferLoadState();
  if (!state) throw new Error('Khong co checkpoint de tiep tuc.');
  if (state.status === 'pause_requested') {
    _transferLog(state, '⏸ Dang cho checkpoint hoan tat truoc khi tiep tuc.');
    _transferSaveState(state);
    return { ok: true, jobId: state.jobId, pauseRequested: true };
  }
  if (state.status === 'scanning' || state.status === 'transferring') {
    return { ok: true, jobId: state.jobId, alreadyRunning: true };
  }
  if (state.status === 'done' || state.status === 'error') {
    return { ok: false, jobId: state.jobId, notReady: true, status: state.status };
  }
  if (state.status !== 'paused' && state.status !== 'awaiting_confirm') {
    return { ok: false, jobId: state.jobId, notReady: true, status: state.status };
  }

  state.phase = state.phase || 'scan';
  state.status = state.phase === 'transfer' ? 'transferring' : 'scanning';
  state.waitingForResume = false;
  state.updatedAt = new Date().toISOString();
  _transferProps().setProperty(TRANSFER_ACTIVE_JOB_ID_KEY, state.jobId);
  _transferLog(state, '▶ Tiep tuc tu checkpoint.');
  _transferSaveState(state);
  return { ok: true, jobId: state.jobId };
}

function continueOwnershipTransfer(jobId) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return { ok: false, busy: true };

  var state = null;
  try {
    state = _transferLoadState();
    if (!state) { _transferDeleteTrigger(); return; }
    if (jobId && state.jobId && jobId !== state.jobId) return;
    if (state.status === 'pause_requested') {
      _transferDeleteTrigger();
      _transferFinalizePauseCheckpoint(state);
      return { ok: true, pauseRequested: true };
    }
    if (state.status === 'paused') state.status = state.phase === 'transfer' ? 'transferring' : 'scanning';
    if (state.status === 'awaiting_confirm') { _transferDeleteTrigger(); return; }
    state.waitingForResume = false;
    _transferRun(state);
    return { ok: true };
  } catch (e) {
    _transferDeleteTrigger();
    if (state) {
      state.status = 'error';
      state.updatedAt = new Date().toISOString();
      _transferLog(state, '✗ LOI: ' + (e && e.message ? e.message : e));
      _transferSaveState(state);
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function pauseOwnershipTransfer(jobId) {
  _transferDeleteTrigger();
  var state = _transferLoadState();
  if (state) {
    if (jobId && state.jobId && jobId !== state.jobId) return { ok: true, stale: true };
    _transferProps().setProperty(TRANSFER_PAUSED_JOB_ID_KEY, state.jobId);
    if (state.status !== 'scanning' && state.status !== 'transferring') {
      state.waitingForResume = false;
      state.updatedAt = new Date().toISOString();
      _transferLog(state, '⏸ Da yeu cau ngung. Script se luu checkpoint o diem an toan gan nhat...');
      _transferSaveState(state);
    }
  }
  return { ok: true };
}

function clearOwnershipTransferCheckpoint() {
  _transferDeleteTrigger();
  var state = _transferLoadState();
  if (state && state.jobId) _transferProps().setProperty(TRANSFER_RESET_JOB_ID_KEY, state.jobId);
  _transferDeleteCheckpoint();
  return { ok: true };
}

function transferOwnershipCli() {
  _transferDeleteCheckpoint();
  _transferDeleteTrigger();
  var res = startOwnershipTransfer(CLI_NEW_OWNER_EMAIL, CLI_FOLDER_ID, CLI_DIRECT_TRANSFER);
  var state = _transferLoadState();
  _transferRun(state);
  if (!CLI_DRY_RUN && state.status === 'awaiting_confirm') {
    state.phase = 'transfer';
    state.status = 'transferring';
    _transferRun(state);
  }
  Logger.log('Job: %s', res.jobId);
}

function _transferRun(state) {
  if (state.phase === 'transfer') {
    _transferRunTransfer(state);
    return;
  }
  _transferRunScan(state);
}

function _transferRunScan(state) {
  var startTime = Date.now();
  var itemsSinceLastSave = 0;
  var lastSaveTime = startTime;

  while (state.queue.length > 0) {
    if (_transferCheckpointIfPaused(state)) return;
    if (_transferIsStaleJob(state)) return;
    if (Date.now() - startTime > TRANSFER_MAX_RUNTIME_MS) {
      _transferCheckpointScan(state, null);
      return;
    }

    var folderId = state.queue.shift();
    if (state.visited[folderId]) continue;
    state.visited[folderId] = true;

    var folderMeta;
    try {
      folderMeta = _transferGetDriveFileMeta(folderId);
    } catch (e) {
      _transferLog(state, '✗ Khong mo duoc folder id=' + folderId + ': ' + e.message);
      _transferSaveState(state);
      continue;
    }

    _transferLog(state, '▶ Dang quet folder: ' + _transferGetDriveFileName(folderMeta));
    _transferScanDriveFileMeta(folderMeta, true, state, lastSaveTime);
    itemsSinceLastSave++;

    var pageToken = null;
    do {
      if (_transferCheckpointIfPaused(state)) return;
      if (_transferIsStaleJob(state)) return;
      if (Date.now() - startTime > TRANSFER_MAX_RUNTIME_MS) {
        _transferCheckpointScan(state, folderId);
        return;
      }

      var childPage = _transferListDriveChildren(folderId, pageToken);
      var children = childPage.items || childPage.files || [];
      for (var i = 0; i < children.length; i++) {
        if (_transferCheckpointIfPaused(state)) return;
        if (_transferIsStaleJob(state)) return;
        if (Date.now() - startTime > TRANSFER_MAX_RUNTIME_MS) {
          _transferCheckpointScan(state, folderId);
          return;
        }
        var child = children[i];
        var isFolder = _transferIsDriveFolder(child);
        if (isFolder) {
          if (!state.visited[child.id]) state.queue.push(child.id);
        }
        _transferScanDriveFileMeta(child, isFolder, state, lastSaveTime);
        itemsSinceLastSave++;
        if (_transferShouldSave(itemsSinceLastSave, lastSaveTime)) {
          state.updatedAt = new Date().toISOString();
          _transferSaveState(state);
          itemsSinceLastSave = 0;
          lastSaveTime = Date.now();
        }
      }
      pageToken = childPage.nextPageToken || null;
    } while (pageToken);
  }

  _transferDeleteTrigger();
  state.updatedAt = new Date().toISOString();
  state.status = state.matches.length ? 'awaiting_confirm' : 'done';
  state.resumePhase = 'done';
  _transferLog(state, '---------------------------------------------');
  _transferLog(state, '✅ QUET XONG');
  _transferLog(state, 'Da quet       : ' + state.stats.scanned + ' muc');
  _transferLog(state, 'Ban la owner  : ' + state.stats.owned + ' muc');
  _transferLog(state, 'Co the xu ly  : ' + state.stats.eligible + ' muc');
  if (state.stats.pending) {
    _transferLog(state, 'Da pending    : ' + state.stats.pending + ' muc da gui yeu cau owner truoc do');
  }
  if (state.matches.length) {
    _transferLog(state, 'Cho xac nhan de ' + (state.directTransfer ? 'chuyen owner' : 'gui yeu cau owner') + '.');
    if (!state.directTransfer) {
      _transferLog(state, '⚠ Gmail/consumer: nguoi nhan can chap nhan loi moi owner cho tung folder/file. Email thong bao co the khong den.');
    }
  } else {
    _transferLog(state, 'Khong co item nao phu hop de chuyen owner.');
  }
  _transferSaveState(state);
}

function _transferScanDriveFileMeta(file, isFolder, state, lastSaveTime) {
  if (!state.scannedIds) state.scannedIds = {};
  if (!file || !file.id || state.scannedIds[file.id]) return;
  state.scannedIds[file.id] = true;
  state.stats.scanned++;
  if (Date.now() - lastSaveTime >= TRANSFER_SAVE_EVERY_MS) {
    state.updatedAt = new Date().toISOString();
    _transferSaveState(state);
  }

  if (_transferIsInSharedDrive(file)) {
    state.stats.skipped++;
    return;
  }

  var ownerEmail = _transferGetOwnerEmail(file);
  if (!_transferIsCurrentUserOwner(ownerEmail)) return;

  state.stats.owned++;
  if (ownerEmail === state.newOwnerEmail) {
    state.stats.skipped++;
    return;
  }

  var name = _transferGetDriveFileName(file);
  var label = (isFolder ? '[Folder] ' : '[File]   ') + name;
  var permission = _transferFindUserPermission(file.id, state.newOwnerEmail);

  if (permission && permission.pendingOwner) {
    state.stats.pending = (state.stats.pending || 0) + 1;
    state.stats.skipped++;
    _transferLog(state, '• DA GUI YEU CAU → ' + label + ' pending owner=' + state.newOwnerEmail);
    return;
  }

  state.matches.push({
    id: file.id,
    name: name,
    type: isFolder ? 'folder' : 'file',
    ownerEmail: ownerEmail,
    permissionId: permission ? permission.id : '',
    currentRole: permission ? permission.role : ''
  });
  state.stats.eligible = state.matches.length;
  _transferLog(state, '• CO THE CHUYEN → ' + label + ' owner=' + ownerEmail);
}

function _transferRunTransfer(state) {
  var startTime = Date.now();
  var itemsSinceLastSave = 0;
  var lastSaveTime = startTime;
  var matches = state.matches || [];

  while (state.transferIndex < matches.length) {
    if (_transferCheckpointIfPaused(state)) return;
    if (_transferIsStaleJob(state)) return;
    if (Date.now() - startTime > TRANSFER_MAX_RUNTIME_MS) {
      state.pass++;
      state.waitingForResume = true;
      state.updatedAt = new Date().toISOString();
      _transferLog(state, '⏸ Sap timeout — da luu checkpoint. Se tiep tuc sau vai giay...');
      _transferLog(state, '   Con: ' + (matches.length - state.transferIndex) + ' muc | Da gui yeu cau: ' + state.stats.requested + ' | Da chuyen: ' + state.stats.transferred);
      _transferSaveState(state);
      return;
    }

    _transferMatchedItem(matches[state.transferIndex], state);
    state.transferIndex++;
    itemsSinceLastSave++;
    if (_transferShouldSave(itemsSinceLastSave, lastSaveTime)) {
      state.updatedAt = new Date().toISOString();
      _transferSaveState(state);
      itemsSinceLastSave = 0;
      lastSaveTime = Date.now();
    }
  }

  _transferDeleteTrigger();
  if (state.resumePhase === 'scan' && state.queue && state.queue.length > 0) {
    state.phase = 'scan';
    state.status = 'paused';
    state.resumePhase = 'scan';
    state.waitingForResume = false;
    state.updatedAt = new Date().toISOString();
    _transferLog(state, '▶ Da xu ly xong cac muc da xac nhan. Con ' + state.queue.length + ' folder trong queue.');
    _transferLog(state, '⏸ Da luu checkpoint. Bam Tiep tuc de quet tiep.');
    _transferSaveState(state);
    return;
  }

  state.resumePhase = '';
  state.status = 'done';
  state.updatedAt = new Date().toISOString();
  _transferLog(state, '---------------------------------------------');
  _transferLog(state, '✅ HOAN TAT');
  _transferLog(state, 'Da transfer truc tiep : ' + state.stats.transferred + ' muc');
  _transferLog(state, 'Da gui yeu cau        : ' + state.stats.requested + ' muc');
  if (!state.directTransfer && state.stats.requested) {
    _transferLog(state, '⚠ Gmail/consumer: pending owner da gui. Nguoi nhan mo link file/folder, vao Chia se, roi chap nhan loi moi so huu cho tung item.');
  }
  if (state.stats.failed) _transferLog(state, '⚠ Khong xu ly duoc    : ' + state.stats.failed + ' muc');
  _transferSaveState(state);
}

function _transferMatchedItem(match, state) {
  var label = (match.type === 'folder' ? '[Folder] ' : '[File]   ') + match.name;
  try {
    if (state.directTransfer) {
      _transferUpsertOwnerPermission(match.id, state.newOwnerEmail, match.permissionId);
      state.stats.transferred++;
      _transferLog(state, '✓ da chuyen owner → ' + label);
    } else {
      _transferUpsertPendingOwnerPermission(match.id, state.newOwnerEmail, match.permissionId);
      state.stats.requested++;
      _transferLog(state, '✓ da gui yeu cau owner → ' + label);
    }
  } catch (e) {
    state.stats.failed++;
    _transferLog(state, '✗ LOI (' + e.message + ') → ' + label);
  }
}

function _transferGetDriveFileMeta(fileId) {
  return Drive.Files.get(fileId, {
    supportsAllDrives: true,
    fields: 'id,title,mimeType,owners(emailAddress),driveId,teamDriveId'
  });
}

function _transferListDriveChildren(folderId, pageToken) {
  return Drive.Files.list({
    q: "'" + _transferEscapeDriveQueryValue(folderId) + "' in parents and trashed = false",
    maxResults: TRANSFER_DRIVE_LIST_PAGE_SIZE,
    pageSize: TRANSFER_DRIVE_LIST_PAGE_SIZE,
    pageToken: pageToken || undefined,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'nextPageToken,items(id,title,mimeType,owners(emailAddress),driveId,teamDriveId)'
  });
}

function _transferUpsertOwnerPermission(fileId, email, permissionId) {
  if (permissionId) {
    Drive.Permissions.update({ role: 'owner' }, fileId, permissionId, {
      supportsAllDrives: true,
      transferOwnership: true,
      sendNotificationEmails: true
    });
    return;
  }
  Drive.Permissions.insert({ type: 'user', role: 'owner', value: email, emailAddress: email }, fileId, {
    supportsAllDrives: true,
    transferOwnership: true,
    sendNotificationEmails: true
  });
}

function _transferUpsertPendingOwnerPermission(fileId, email, permissionId) {
  var body = { type: 'user', role: 'writer', value: email, emailAddress: email, pendingOwner: true };
  if (permissionId) {
    Drive.Permissions.update(body, fileId, permissionId, {
      supportsAllDrives: true,
      sendNotificationEmails: true
    });
    return;
  }
  Drive.Permissions.insert(body, fileId, {
    supportsAllDrives: true,
    sendNotificationEmails: true
  });
}

function _transferFindUserPermission(fileId, email) {
  var res = Drive.Permissions.list(fileId, { supportsAllDrives: true });
  var items = res.items || res.permissions || [];
  for (var i = 0; i < items.length; i++) {
    var p = items[i];
    var permEmail = (p.emailAddress || p.value || '').toLowerCase();
    if (permEmail === email) return p;
  }
  return null;
}

function _transferGetOwnerEmail(file) {
  return file && file.owners && file.owners.length
    ? (file.owners[0].emailAddress || '').toLowerCase()
    : '';
}

function _transferIsCurrentUserOwner(ownerEmail) {
  var currentUserEmail = _transferGetCurrentUserEmail();
  return !!ownerEmail && !!currentUserEmail && ownerEmail === currentUserEmail;
}

function _transferGetCurrentUserEmail() {
  var about = Drive.About.get({
    fields: 'user(emailAddress)'
  });
  return about && about.user && about.user.emailAddress
    ? about.user.emailAddress.toLowerCase()
    : '';
}

function _transferIsInSharedDrive(file) {
  return !!(file && (file.driveId || file.teamDriveId));
}

function _transferCheckpointScan(state, currentFolderId) {
  state.pass++;
  if (currentFolderId) {
    state.visited[currentFolderId] = false;
    state.queue.unshift(currentFolderId);
  }
  state.waitingForResume = true;
  state.status = 'scanning';
  state.resumePhase = 'scan';
  state.updatedAt = new Date().toISOString();
  _transferLog(state, '⏸ Sap timeout — da luu checkpoint. Se tiep tuc quet sau vai giay...');
  _transferLog(state, '   Queue con: ' + state.queue.length + ' folder | Da quet: ' + state.stats.scanned + ' | Co the xu ly: ' + state.stats.eligible);
  _transferSaveState(state);
}

function _transferCheckpointIfPaused(state) {
  if (!state || !state.jobId) return false;
  if (_transferProps().getProperty(TRANSFER_PAUSED_JOB_ID_KEY) !== state.jobId) return false;
  _transferFinalizePauseCheckpoint(state);
  return true;
}

function _transferFinalizePauseCheckpoint(state) {
  _transferProps().deleteProperty(TRANSFER_PAUSED_JOB_ID_KEY);
  state.waitingForResume = false;
  state.updatedAt = new Date().toISOString();
  var pendingTransfer = (state.matches || []).length - (state.transferIndex || 0);
  if (pendingTransfer > 0) {
    state.status = 'awaiting_confirm';
    state.resumePhase = state.phase === 'transfer' ? '' : 'scan';
    _transferLog(state, '⏸ Da ngung tai checkpoint. Co ' + pendingTransfer + ' muc dang cho xac nhan chuyen owner.');
    if (state.resumePhase === 'scan') {
      _transferLog(state, '   Ban co the bam Tiep tuc de quet tiep, hoac Xac nhan chuyen owner cho cac muc da tim thay.');
    }
  } else {
    state.status = 'paused';
    state.resumePhase = state.phase || 'scan';
    _transferLog(state, '⏸ Da ngung tai checkpoint. Chua co muc can chuyen owner trong batch hien tai.');
  }
  _transferSaveState(state);
}

function _transferIsStaleJob(state) {
  var props = _transferProps();
  if (props.getProperty(TRANSFER_RESET_JOB_ID_KEY) === state.jobId) {
    state.waitingForResume = false;
    _transferDeleteTrigger();
    return true;
  }
  var activeJobId = props.getProperty(TRANSFER_ACTIVE_JOB_ID_KEY);
  if (activeJobId && activeJobId !== state.jobId) {
    state.waitingForResume = false;
    _transferDeleteTrigger();
    return true;
  }
  return false;
}

function _transferCanResumeExistingJob(state, email, folderId, directTransfer) {
  if (!state || !state.jobId) return false;
  if (state.newOwnerEmail !== email || state.rootId !== folderId || !!state.directTransfer !== !!directTransfer) return false;
  if (state.status === 'done' || state.status === 'error') return false;
  return true;
}

function _transferSaveState(state) {
  if (!state || !state.jobId) return;
  var props = _transferProps();
  if (props.getProperty(TRANSFER_RESET_JOB_ID_KEY) === state.jobId) return;

  var activeJobId = props.getProperty(TRANSFER_ACTIVE_JOB_ID_KEY);
  if (activeJobId && state.jobId && activeJobId !== state.jobId) return;
  if (!activeJobId && state.jobId) props.setProperty(TRANSFER_ACTIVE_JOB_ID_KEY, state.jobId);

  if (props.getProperty(TRANSFER_PAUSED_JOB_ID_KEY) === state.jobId &&
      (state.status === 'scanning' || state.status === 'transferring')) {
    state.status = 'pause_requested';
    state.waitingForResume = false;
  }

  var json = JSON.stringify(state);
  var fileId = props.getProperty(TRANSFER_STATE_FILE_ID_KEY);
  if (fileId) {
    try {
      DriveApp.getFileById(fileId).setContent(json);
      props.setProperty(TRANSFER_PROPS_KEY, 'drive-file:' + fileId);
      return;
    } catch (e) {
      props.deleteProperty(TRANSFER_STATE_FILE_ID_KEY);
    }
  }

  var file = DriveApp.createFile('drive-transfer-owner-state-' + new Date().getTime() + '.json', json, MimeType.PLAIN_TEXT);
  props.setProperty(TRANSFER_STATE_FILE_ID_KEY, file.getId());
  props.setProperty(TRANSFER_PROPS_KEY, 'drive-file:' + file.getId());
}

function _transferLoadState() {
  var props = _transferProps();
  var fileId = props.getProperty(TRANSFER_STATE_FILE_ID_KEY);
  if (fileId) {
    try {
      return JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString());
    } catch (e) {
      props.deleteProperty(TRANSFER_STATE_FILE_ID_KEY);
    }
  }
  var raw = props.getProperty(TRANSFER_PROPS_KEY);
  if (!raw || raw.indexOf('drive-file:') === 0) return null;
  return JSON.parse(raw);
}

function _transferDeleteCheckpoint() {
  var props = _transferProps();
  var fileId = props.getProperty(TRANSFER_STATE_FILE_ID_KEY);
  if (fileId) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {}
  }
  props.deleteProperty(TRANSFER_PROPS_KEY);
  props.deleteProperty(TRANSFER_STATE_FILE_ID_KEY);
  props.deleteProperty(TRANSFER_ACTIVE_JOB_ID_KEY);
  props.deleteProperty(TRANSFER_PAUSED_JOB_ID_KEY);
}

function _transferDeleteTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRANSFER_CONTINUE_FUNC) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function _transferProps() {
  return PropertiesService.getUserProperties();
}

function _transferLog(state, msg) {
  if (!state.logs) state.logs = [];
  if (!state.logOffset) state.logOffset = 0;
  if (!state.logSeq) state.logSeq = state.logOffset + state.logs.length;
  state.logs.push(msg);
  state.logSeq++;
  while (state.logs.length > TRANSFER_MAX_LOG_LINES) {
    state.logs.shift();
    state.logOffset++;
  }
}

function _transferShouldSave(itemsSinceLastSave, lastSaveTime) {
  return itemsSinceLastSave >= TRANSFER_SAVE_EVERY || Date.now() - lastSaveTime >= TRANSFER_SAVE_EVERY_MS;
}

function _transferIsDriveFolder(file) {
  return file && file.mimeType === 'application/vnd.google-apps.folder';
}

function _transferGetDriveFileName(file) {
  return file.title || file.id;
}

function _transferEscapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
