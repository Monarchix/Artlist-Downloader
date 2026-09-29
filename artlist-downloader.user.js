// ==UserScript==
// @name        Artlist DL
// @namespace   https://github.com/Monarchix/artlist-downloader
// @description Download Artlist.io music, SFX, albums, packs, similar songs & stock footage (HLS preview) — with an in-page settings panel, folder routing, genre sorting, resolution picker and bulk download.
// @author      Monarchix (fork) · original by Mia (https://github.com/xNasuni)
// @match       *://*.artlist.io/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_notification
// @grant       GM_setClipboard
// @grant       GM_openInTab
// @connect     cms-public-artifacts.artlist.io
// @connect     cms-artifacts.artlist.io
// @connect     fonts.googleapis.com
// @connect     fonts.gstatic.com
// @connect     127.0.0.1
// @require     https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @version     1.2.0
// @run-at      document-start
// @updateURL   https://github.com/Monarchix/artlist-downloader/raw/main/artlist-downloader.user.js
// @downloadURL https://github.com/Monarchix/artlist-downloader/raw/main/artlist-downloader.user.js
// @supportURL  https://github.com/Monarchix/artlist-downloader/issues
// ==/UserScript==

// Artlist Downloader — enhanced fork
// Original work © Mia (xNasuni) — https://github.com/xNasuni/artlist-downloader
// Licensed under the BSD-3-Clause License (see LICENSE).
// This fork adds: an in-page settings UI, per-type download folders, genre
// sorting, bulk download, ID3 tags, and reliable support for album / SFX-pack /
// similar-songs pages whose track lists are server-rendered.

const LoadedMusicLists = []
const LoadedSfxLists = []
const LoadedSfxsList = []
const LoadedSongsList = []
const LoadedSstemsLists = []
const LoadedFootageLists = []   // stock-footage clips
const ModifiedMusicButtonColor = '#82ff59'
const ModifiedSfxButtonColor = '#ff90bf'
const ModifiedFootageButtonColor = '#5bc8f5' // blue for footage
const ErrorButtonColor = '#ff3333'
const UNKNOWN_DATATYPE = '_unknown'
const NEXTRSC_DATATYPE = '_rsc'
const SINGLE_SOUND_EFFECT_DATATYPE = '_ssfx'
const SINGLE_SONG_DATATYPE = '_ssong'
const MUSIC_ALBUM_PAGETYPE = '_amusic'
const SONGS_PAGETYPE = '_songs'
const MUSIC_PAGETYPE = '_music'
const SFXS_PAGETYPE = '_sfxs'
const SFXP_PAGETYPE = '_sfxp'
const SFX_PAGETYPE = '_sfx'
const SONG_STEMS_PAGETYPE = '_sstem'
const FOOTAGE_PAGETYPE = '_footage'          // /stock-footage browse/search
const FOOTAGE_CLIP_PAGETYPE = '_fclip'       // /stock-footage/clip/<slug>/<id>
const FOOTAGE_STORY_PAGETYPE = '_fstory'     // /stock-footage/story/<slug>/<id> (pack)
const FOOTAGE_COLLECTION_PAGETYPE = '_fcol'  // /stock-footage/collection/<slug>
const oldXMLHttpRequestOpen = unsafeWindow.XMLHttpRequest.prototype.open
const oldFetch = unsafeWindow.fetch

var AudioTable
var TBody
var LastChangeObserver
var ActionContainer
var SongPage
var LastInterval = -1
var RequestsInterval = -1
var RSCInterval = -1
var DontPoll = false
var SingleSoundEffectData = 'none'
var SingleSongData = 'none'

/* ============================================================================
 * Artlist DL — v4 additions: settings, logging/error system, notifications,
 * clipboard, bulk "download all" with progress, file-extension detection,
 * experimental ID3 tagging, and "already downloaded" memory.
 *
 * Everything below is ADDITIVE. It does not touch the network interception or
 * the page-type / data-type matching that the download mechanism depends on.
 * ========================================================================== */

const ARTLIST_DL_VERSION = '1.2.0'

// ---- Settings -------------------------------------------------------------
const SETTINGS_KEY = 'artlist-dl-settings'
const DEFAULT_SETTINGS = {
    filenamePattern: '{type} {artist} - {title} {album}({ids})',
    notifications: true,
    markDownloaded: true,
    confirmRedownload: true, // ask before downloading something already in the history (Shift-click skips)
    autoDetectExtension: true,
    embedTags: false, // experimental: prepend ID3v2 tags (mp3/aac/flac/wav)
    embedCoverArt: false, // fetch and embed cover art into ID3 APIC frame
    concurrency: 3,
    retryCount: 2, // per-item retry attempts on network failure
    showDownloadAll: true,
    showPerTrackProgress: true, // show scrollable per-track progress in overlay
    scrollBeforeDownloadAll: true, // auto-scroll page to load lazy rows before bulk DL
    categorize: true, // sort downloads into nested folders by genre
    categoryDepth: 3, // max nesting depth for multi-genre tracks
    downloadAllCap: 25, // confirm before bulk-downloading more than this many
    skipDownloadedInBulk: false, // skip already-downloaded tracks in "Download all"
    autoSyncFolders: true, // scan output folders on startup to mark local files yellow
    defaultFootageResolution: '1080p', // preferred resolution for bulk footage download
    autoOpenFolder: true, // auto-open Explorer/Finder via the helper after each save, no click needed
    // Full OS paths for "open folder" quick-launch (user pastes once, never re-enters)
    'folderPath.music': '',
    'folderPath.sfx': '',
    'folderPath.footage': '',
    debug: false
}

function gmGet(key, fallback) {
    try {
        if (typeof GM_getValue !== 'undefined') return GM_getValue(key, fallback)
    } catch (e) {}
    return fallback
}
function gmSet(key, value) {
    try {
        if (typeof GM_setValue !== 'undefined') GM_setValue(key, value)
    } catch (e) {}
}

function LoadSettings() {
    let stored = {}
    try {
        const raw = gmGet(SETTINGS_KEY, null)
        if (raw) stored = JSON.parse(raw)
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS, stored)
}

let SETTINGS = LoadSettings()

function GetSetting(key) {
    return SETTINGS[key] !== undefined ? SETTINGS[key] : DEFAULT_SETTINGS[key]
}
function SetSetting(key, value) {
    SETTINGS[key] = value
    gmSet(SETTINGS_KEY, JSON.stringify(SETTINGS))
    return value
}

function Clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n))
}

// ---- Logging / error debugging system -------------------------------------
const ErrorLog = []
const MAX_ERROR_LOG = 100
const UnprocessedPayloads = [] // unrecognised data payloads, for schema debugging
const Captures = [] // raw response snippets our hooks saw, for schema debugging
function Capture(kind, url, text) {
    try {
        Captures.push({
            time: new Date().toISOString(),
            kind: kind,
            url: String(url).slice(0, 200),
            datatype: typeof MatchURL === 'function' ? MatchURL(url) : '?',
            length: text ? text.length : 0,
            snippet: typeof text === 'string' ? text.slice(0, 2500) : String(text)
        })
        if (Captures.length > 30) Captures.shift()
    } catch (e) {}
}

// Every Artlist request URL our hooks see (cheap, no body) — used to find which
// endpoint actually carries the pack/list data when MatchURL doesn't know it.
const RequestLog = []
function RecordRequest(method, url) {
    try {
        const u = String(url)
        if (!/artlist\.io|artlist-/.test(u)) return // skip 3rd-party noise
        RequestLog.push({ method: String(method || 'GET'), url: u.slice(0, 220) })
        if (RequestLog.length > 120) RequestLog.shift()
    } catch (e) {}
}

const AUDIO_KEYS_RE =
    /sitePlayableFilePath|playableFileUrl|audioUrl|"songName"|"audioName"|"sfxs"|"songs"|"songId"|"audioId"|"clipId"|"clipName"|"clipFiles"|"footageFiles"|"stockFootage"/

// Capture the body of an Artlist response that wasn't matched by MatchURL but
// looks like it carries audio data — finds the real pack/list endpoint/shape.
function CaptureXHRIfAudio(xhr, url) {
    try {
        xhr.addEventListener('readystatechange', function () {
            if (xhr.readyState !== 4) return
            try {
                const t = xhr.responseText
                if (t && AUDIO_KEYS_RE.test(t)) {
                    Capture('xhr-audio', xhr.responseURL || url, t)
                }
            } catch (e) {}
        })
    } catch (e) {}
}

// One-click debug bundle for the menu command — everything needed to diagnose
// a page where downloads don't work, in a single clipboard payload.
function BuildDebugReport() {
    const safe = fn => {
        try {
            return fn()
        } catch (e) {
            return 'err: ' + (e && e.message)
        }
    }
    return {
        version: ARTLIST_DL_VERSION,
        url: safe(() => unsafeWindow.location.href),
        pagetype: safe(() => GetPagetype()),
        loaded: {
            music: LoadedMusicLists.length,
            sfxLists: LoadedSfxLists.length,
            sfxs: LoadedSfxsList.length,
            songs: LoadedSongsList.length,
            stems: LoadedSstemsLists.length,
            footage: LoadedFootageLists.length,
            footageClips: safe(() => LoadedFootageLists.flat().length)
        },
        downloadButtonAriaLabels: safe(() =>
            [...unsafeWindow.document.querySelectorAll('button[aria-label]')]
                .map(b => b.getAttribute('aria-label'))
                .filter(l => l && /download/i.test(l))
        ),
        // Per-button DOM structure — lets us see why a button isn't wired without
        // guessing the page markup. Shows labels + the nearest links + testids.
        buttons: safe(() => {
            const out = []
            for (const b of unsafeWindow.document.querySelectorAll('button')) {
                const al = b.getAttribute('aria-label') || ''
                const tx = (b.textContent || '').trim()
                if (!/download/i.test(al) && !/download/i.test(tx)) continue
                const testids = []
                let el = b
                for (let i = 0; i < 14 && el; i++) {
                    const t = el.getAttribute && el.getAttribute('data-testid')
                    if (t) testids.push(t)
                    el = el.parentElement
                }
                let clipHref = null, audioHref = null, anyHref = null
                el = b
                for (let i = 0; i < 14 && el; i++) {
                    if (el.querySelector) {
                        if (!clipHref) { const c = el.querySelector('a[href*="/stock-footage/clip/"]'); if (c) clipHref = c.getAttribute('href') }
                        if (!audioHref) { const s = el.querySelector('a[href*="/song/"],a[href*="/sfx/"],a.truncate[data-testid=Link]'); if (s) audioHref = (s.getAttribute('href') || '') + ' :: ' + s.textContent.trim().slice(0, 40) }
                        if (!anyHref) { const a = el.querySelector('a[href]'); if (a) anyHref = a.getAttribute('href') }
                    }
                    el = el.parentElement
                }
                out.push({
                    ariaLabel: al,
                    text: tx.slice(0, 24),
                    inAudioRow: !!(b.closest && b.closest('[data-testid=AudioRow]')),
                    taggedFootage: b.getAttribute('data-artlist-footage') === '1',
                    processed: b.hasAttribute('artlist-dl-processed'),
                    color: b.style && b.style.color,
                    clipHref: clipHref,
                    audioHref: audioHref,
                    anyHref: anyHref,
                    ancestorTestids: testids
                })
                if (out.length >= 16) break
            }
            return out
        }),
        // "Open folder" depends on all three of these lining up; a report that
        // omits them can't tell a dead helper from an unset path.
        helper: safe(() => ({
            available: HelperAvailable,
            origin: HELPER_ORIGIN,
            paths: {
                music: GetSetting('folderPath.music') || null,
                sfx: GetSetting('folderPath.sfx') || null,
                footage: GetSetting('folderPath.footage') || null
            }
        })),
        recentFootageHls: safe(() => {
            const out = []
            for (const r of RequestLog) if (/footage-hls\/[^?]*_playlist_/.test(r.url)) out.push(r.url)
            return out.slice(-6)
        }),
        nextF: safe(() =>
            unsafeWindow.__next_f
                ? {
                      isArray: Array.isArray(unsafeWindow.__next_f),
                      length: unsafeWindow.__next_f.length
                  }
                : 'absent'
        ),
        sampleRowTitles: safe(() => {
            const root = (typeof TBody !== 'undefined' && TBody) || unsafeWindow.document
            return [
                ...root.querySelectorAll('a.truncate[data-testid=Link]')
            ]
                .slice(0, 6)
                .map(a => a.textContent.trim())
        }),
        sampleLoadedNames: safe(() => {
            const out = []
            for (const lst of LoadedSfxsList)
                for (const s of lst)
                    if (out.length < 6) out.push(s.songName || s.name)
            return out
        }),
        sampleRowHrefs: safe(() => {
            const root =
                (typeof TBody !== 'undefined' && TBody) || unsafeWindow.document
            return [...root.querySelectorAll('a[data-testid=Link]')]
                .slice(0, 10)
                .map(a => a.getAttribute('href'))
        }),
        modal: safe(() => {
            const modals = [
                ...unsafeWindow.document.querySelectorAll('.ReactModal__Content')
            ]
            const links = []
            for (const md of modals)
                for (const a of md.querySelectorAll('a[data-testid=Link]'))
                    links.push(a.getAttribute('href'))
            return {
                count: modals.length,
                downloadButtons: modals.reduce(
                    (n, md) =>
                        n +
                        md.querySelectorAll("button[aria-label='download' i]")
                            .length,
                    0
                ),
                sampleLinks: links.slice(0, 12),
                songsFetched:
                    typeof ModalSongById !== 'undefined' ? ModalSongById.size : 0
            }
        }),
        requests: RequestLog,
        captures: Captures,
        unprocessed: UnprocessedPayloads,
        errors: ErrorLog.slice(-20)
    }
}

function LogDebug() {
    if (!GetSetting('debug')) return
    console.debug('%c[Artlist DL]', 'color:#82ff59;font-weight:bold', ...arguments)
}
function LogWarn() {
    console.warn('[Artlist DL]', ...arguments)
}
function RecordError(context, err, extra) {
    const entry = {
        time: new Date().toISOString(),
        context: context,
        message: String((err && err.message) || err),
        stack: err && err.stack ? String(err.stack) : undefined,
        extra: extra,
        url: location.href
    }
    ErrorLog.push(entry)
    if (ErrorLog.length > MAX_ERROR_LOG) ErrorLog.shift()
    console.error(`[Artlist DL] (${context})`, err, extra !== undefined ? extra : '')
    return entry
}

// ---- Notifications & clipboard --------------------------------------------
function Notify(text, title) {
    LogDebug('notify:', title || '', text)
    if (!GetSetting('notifications')) return
    try {
        if (typeof GM_notification !== 'undefined') {
            GM_notification({ text: text, title: title || 'Artlist DL', timeout: 4000 })
        }
    } catch (e) {}
}

function CopyToClipboard(text) {
    try {
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(text, 'text')
            return true
        }
    } catch (e) {}
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
            return true
        }
    } catch (e) {}
    return false
}

// ---- "Already downloaded" memory ------------------------------------------
// Stored as Map<id, {name, artist, album, ts}> (serialised as [[id, meta], ...])
// Legacy Set-format (array of plain strings) is migrated on first load.
const DOWNLOADED_KEY = 'artlist-dl-downloaded'
function LoadDownloaded() {
    try {
        const raw = gmGet(DOWNLOADED_KEY, null)
        if (!raw) return new Map()
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
            const m = new Map()
            for (const entry of parsed) {
                if (Array.isArray(entry) && entry.length === 2) {
                    // new format: [id, meta]
                    m.set(String(entry[0]), entry[1] || {})
                } else if (typeof entry === 'string') {
                    // legacy format: plain id string
                    m.set(entry, {})
                }
            }
            return m
        }
    } catch (e) {}
    return new Map()
}
let DownloadedIds = LoadDownloaded()

function _saveDownloaded() {
    gmSet(DOWNLOADED_KEY, JSON.stringify([...DownloadedIds]))
}

function TagId(d) {
    if (!d) return null
    const parts = [d.artistId, d.albumId, d.songId].filter(
        x => x !== undefined && x !== null
    )
    return parts.length ? parts.join('.') : null
}
function IsDownloaded(id) {
    return !!id && DownloadedIds.has(id)
}
function MarkDownloaded(id, name, artist, album) {
    if (!id || !GetSetting('markDownloaded')) return
    if (DownloadedIds.has(id)) return
    DownloadedIds.set(id, {
        name: name || '',
        artist: artist || '',
        album: album || '',
        ts: new Date().toISOString()
    })
    _saveDownloaded()
}
// ---- Download log ----------------------------------------------------------
// One row per save attempt: what, where, when, and whether it worked. Separate
// from DownloadedIds above, which is only the "have I got this?" index. Failed
// rows keep a `retry` payload so they can be re-run from the History card.
// The block between the markers is pure (no DOM, no storage) and unit-tested by
// tools/test-download-log.js -- keep it that way.
// <download-log-core>
const LOG_KEY = 'artlist-dl-log'
const LOG_MAX = 500

// Identity of an item across attempts. The file name is a last resort: a failed
// row holds the bare base name while a saved one holds name + extension, so
// artist/title is the better key when there is no id.
function LogKey(e) {
    const who = e.id || [e.artist, e.title].filter(Boolean).join(' - ') || e.file || ''
    return (e.kind || '') + '|' + who
}

// Returns a new array; never mutates `log`. A fresh result for an item replaces
// its earlier failure, so a retry that works leaves no stale "failed" row. Past
// LOG_MAX the oldest *successful* rows go first: a failure with its retry payload
// is the one thing the user can still act on, so it is never evicted.
function LogAppend(log, entry, now) {
    const ts = now || new Date().toISOString()
    const { retry, ...rest } = entry
    const stamped = entry.status === 'failed' ? { ...entry, ts } : { ...rest, ts }
    const key = LogKey(stamped)
    const next = [...log.filter(e => !(e.status === 'failed' && LogKey(e) === key)), stamped]
    let excess = next.length - LOG_MAX
    if (excess <= 0) return next
    return next.filter(e => e.status === 'failed' || excess-- <= 0)
}

function LogFailed(log) {
    return log.filter(e => e.status === 'failed')
}

// Newest successful save of an item, or null.
function LogLatestOk(log, id) {
    if (!id) return null
    for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].status === 'ok' && log[i].id === id) return log[i]
    }
    return null
}

// Spreadsheets run a cell starting with = + - @ as a formula, and track titles
// are page-supplied text, so neutralise those.
function CsvCell(v) {
    let s = String(v == null ? '' : v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    return '"' + s.replace(/"/g, '""') + '"'
}

// `known` is the id -> {name, artist, album, ts} index; ids already present in
// the log are skipped so nothing appears twice.
function LogToCsv(log, known) {
    const head = ['id', 'kind', 'title', 'artist', 'album', 'file', 'folder', 'status', 'error', 'date']
    const rows = [head.map(CsvCell).join(',')]
    const seen = new Set()
    for (const e of log) {
        if (e.id) seen.add(e.id)
        rows.push(
            [e.id, e.kind, e.title, e.artist, e.album, e.file, e.folder, e.status, e.error, e.ts]
                .map(CsvCell)
                .join(',')
        )
    }
    for (const [id, m] of known || []) {
        if (seen.has(id)) continue
        const meta = m || {}
        rows.push(
            [id, '', meta.name, meta.artist, meta.album, '', '', 'known', '', meta.ts]
                .map(CsvCell)
                .join(',')
        )
    }
    return rows.join('\n')
}
// </download-log-core>

function LoadLog() {
    try {
        const raw = gmGet(LOG_KEY, null)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed : []
    } catch (e) {
        return []
    }
}
let DownloadLog = LoadLog()

function RecordDownload(entry) {
    try {
        // Re-read first: GM storage is shared by every open Artlist tab, and
        // appending to this tab's stale copy would overwrite the other tab's rows.
        DownloadLog = LogAppend(LoadLog(), entry)
        gmSet(LOG_KEY, JSON.stringify(DownloadLog))
    } catch (e) {
        RecordError('RecordDownload', e)
    }
}

// Fields every log row takes from a tags object (audio and footage share it).
function EntryFromTags(tags, kind, file, folder) {
    const t = tags || {}
    return {
        kind: kind || 'music',
        id: t.id || '',
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || '',
        file: file || '',
        folder: folder || ''
    }
}

const DownloadedButtonColor = '#ffd400' // yellow = already downloaded

// Yellow tint plus a small check badge, so a downloaded track is recognisable at
// a glance and not only by colour. The badge is a pseudo-element, so it needs no
// extra DOM inside Artlist's buttons.
const BADGE_STYLE_ID = 'artlist-dl-badge-style'
function EnsureBadgeStyle() {
    try {
        if (document.getElementById(BADGE_STYLE_ID)) return
        const host = document.head || document.documentElement
        if (!host) return
        const s = document.createElement('style')
        s.id = BADGE_STYLE_ID
        s.textContent =
            '[data-artlist-dl-done]::after{content:"\\2713";position:absolute;top:-5px;right:-5px;' +
            'width:15px;height:15px;border-radius:50%;background:' + DownloadedButtonColor + ';color:#111;' +
            'font:700 10px/15px system-ui,sans-serif;text-align:center;pointer-events:none;' +
            'box-shadow:0 0 0 2px #121212;z-index:2}'
        host.appendChild(s)
    } catch (e) {}
}

function DownloadedTitle(id) {
    const hit = LogLatestOk(DownloadLog, id)
    if (!hit) return 'Artlist DL: already downloaded (Shift-click to skip the prompt)'
    const when = new Date(hit.ts).toLocaleDateString()
    const where = [hit.folder, hit.file].filter(Boolean).join('/')
    return 'Artlist DL: downloaded ' + when + (where ? ' - ' + where : '')
}

function ApplyDownloadedStyle(button) {
    if (!button) return
    button.style.color = DownloadedButtonColor
    button.style.borderColor = DownloadedButtonColor
    button.style.filter = ''
    button.setAttribute('data-artlist-dl-done', '1')
    // The badge is absolutely positioned against the button.
    try {
        if (unsafeWindow.getComputedStyle(button).position === 'static') {
            button.style.position = 'relative'
        }
    } catch (e) {}
    button.title = DownloadedTitle(button.getAttribute('data-artlist-dl-id'))
    EnsureBadgeStyle()
}

// Clicking a track you already have asks first, since that is the click that
// wastes a download. Shift-click, or the setting, turns the prompt off.
function ConfirmRedownload(id, label) {
    if (!id || !IsDownloaded(id) || !GetSetting('confirmRedownload')) return true
    const hit = LogLatestOk(DownloadLog, id)
    const when = hit ? ' on ' + new Date(hit.ts).toLocaleDateString() : ''
    const yes = unsafeWindow.confirm(
        'Artlist DL: "' + (label || id) + '" was already downloaded' + when +
        '.\n\nDownload it again?\n(Hold Shift when clicking to skip this question.)'
    )
    // Chrome's "stop this page creating dialogs" makes confirm() answer no for
    // good, which would otherwise look like a dead button.
    if (!yes) Notify('Skipped: already downloaded (Shift-click to download again)', 'Artlist DL')
    return yes
}

function BuildTags(d, trackNum) {
    if (!d) return null
    const genres = GetCategoryFromData(d)
    let year = ''
    try {
        const raw = d.year || d.releaseYear || d.createdAt || ''
        if (raw) year = String(raw).slice(0, 4)
    } catch (e) {}
    return {
        title: d._songName || d.songName || d.name || '',
        artist: d.artistName || '',
        album: d._albumName || d.albumName || '',
        genre: genres.join(', '),
        year: year,
        bpm: d.bpm != null ? String(d.bpm) : (d.tempo != null ? String(d.tempo) : ''),
        trackNum: trackNum != null ? String(trackNum) : '',
        coverUrl: d.albumCoverUrl || d.coverUrl || d.artwork || d.coverArtUrl || d.thumbnailUrl || '',
        id: TagId(d)
    }
}

// ---- Networking / file helpers --------------------------------------------
function FetchBlob(url) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { Referer: 'https://artlist.io/' },
                responseType: 'blob',
                onload: res => {
                    if (!res.response) return reject(new Error('empty response'))
                    let contentType = ''
                    try {
                        const m = (res.responseHeaders || '').match(
                            /content-type:\s*([^\r\n]+)/i
                        )
                        if (m) contentType = m[1].trim()
                    } catch (e) {}
                    resolve({ blob: res.response, contentType: contentType })
                },
                onerror: err =>
                    reject(
                        new Error(
                            'GM_xmlhttpRequest failed: ' +
                                ((err && err.error) || 'unknown')
                        )
                    )
            })
        } else {
            fetch(url, { headers: { Referer: 'https://artlist.io/' } })
                .then(async r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status)
                    resolve({
                        blob: await r.blob(),
                        contentType: r.headers.get('content-type') || ''
                    })
                })
                .catch(reject)
        }
    })
}

const CONTENT_TYPE_EXT = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/aac': 'aac',
    'audio/aacp': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/webm': 'webm'
}
function ExtFromContentType(contentType, url) {
    const ct = (contentType || '').toLowerCase()
    for (const key in CONTENT_TYPE_EXT) {
        if (ct.indexOf(key) !== -1) return CONTENT_TYPE_EXT[key]
    }
    try {
        const path = new URL(url).pathname
        const m = path.match(/\.([a-z0-9]{2,4})(?:$|\?)/i)
        if (m) return m[1].toLowerCase()
    } catch (e) {}
    return 'aac'
}
function MimeForExt(ext) {
    for (const key in CONTENT_TYPE_EXT) {
        if (CONTENT_TYPE_EXT[key] === ext) return key
    }
    return 'audio/aac'
}

function SanitizeFilename(name) {
    return String(name)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
}

// ---- Category / genre extraction ------------------------------------------
function NormalizeGenres(val) {
    if (!val) return []
    if (typeof val === 'string') {
        return val
            .split(/[,/|>•·]+/)
            .map(s => s.trim())
            .filter(Boolean)
    }
    if (Array.isArray(val)) {
        return val
            .map(x =>
                typeof x === 'string'
                    ? x
                    : x && (x.name || x.title || x.value || x.label || x.text)
            )
            .map(s => String(s || '').trim())
            .filter(Boolean)
    }
    if (typeof val === 'object') {
        const s = val.name || val.title || val.value || val.label
        return s ? [String(s).trim()] : []
    }
    return []
}
// Likely field names on Artlist song objects — refine with ArtlistDL.sampleSong()
const GENRE_FIELDS = [
    'genres',
    'genre',
    'categories',
    'category',
    'musicStyles',
    'musicStyle',
    'styles',
    'style',
    'subGenres',
    'moods',
    'mood',
    'tags'
]
function GetCategoryFromData(d) {
    if (!d) return []
    for (const f of GENRE_FIELDS) {
        if (d[f] != null) {
            const g = NormalizeGenres(d[f])
            if (g.length) return g
        }
    }
    return []
}
function GetCategoryFromRow(row) {
    if (!row || !row.querySelectorAll) return []
    // genre links typically point at a genre/style/mood browse page
    const links = row.querySelectorAll(
        'a[href*="genre"], a[href*="style"], a[href*="mood"], a[href*="category"]'
    )
    const out = []
    for (const a of links) {
        const t = (a.textContent || '').trim()
        if (t) out.push(t)
    }
    if (out.length) return out
    const tagged = row.querySelector(
        '[data-testid*="genre"], [data-testid*="Genre"], [data-testid*="style"], [data-testid*="Style"], [class*="genre"]'
    )
    if (tagged) return NormalizeGenres(tagged.textContent)
    return []
}
function SanitizeFolderName(name) {
    return String(name)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+|\.+$/g, '')
        .trim()
        .slice(0, 80)
}
function GetCategory(audioData, rowElement) {
    if (!GetSetting('categorize')) return []
    let genres = GetCategoryFromData(audioData)
    if (!genres.length && rowElement) genres = GetCategoryFromRow(rowElement)
    const depth = Clamp(GetSetting('categoryDepth') || 3, 1, 5)
    return genres.slice(0, depth).map(SanitizeFolderName).filter(Boolean)
}

// ---- Output folders (File System Access API; Chrome/Edge only) -------------
// Separate roots for music and SFX so they never mix on disk.
const OUTPUT_KINDS = ['music', 'sfx', 'footage']
const OutputDirHandles = { music: null, sfx: null, footage: null }
function OutputKey(kind) {
    return 'outputDir.' + kind
}
function IsSfxPagetype(pt) {
    return (
        pt === SFX_PAGETYPE ||
        pt === SFXS_PAGETYPE ||
        pt === SFXP_PAGETYPE ||
        pt === SINGLE_SOUND_EFFECT_DATATYPE
    )
}
function IsFootagePagetype(pt) {
    return pt === FOOTAGE_PAGETYPE || pt === FOOTAGE_CLIP_PAGETYPE ||
           pt === FOOTAGE_STORY_PAGETYPE || pt === FOOTAGE_COLLECTION_PAGETYPE
}
function KindForPagetype(pt) {
    if (IsFootagePagetype(pt)) return 'footage'
    return IsSfxPagetype(pt) ? 'sfx' : 'music'
}
function GetOutputHandle(kind) {
    return OutputDirHandles[kind || 'music'] || null
}

function idbRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}
function idbOpen() {
    return new Promise((resolve, reject) => {
        const idb = unsafeWindow.indexedDB || indexedDB
        const r = idb.open('artlist-dl', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('handles')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
    })
}
async function idbSet(key, val) {
    try {
        const db = await idbOpen()
        const tx = db.transaction('handles', 'readwrite')
        tx.objectStore('handles').put(val, key)
        await new Promise((res, rej) => {
            tx.oncomplete = () => res()
            tx.onerror = () => rej(tx.error)
        })
    } catch (e) {
        RecordError('idbSet', e)
    }
}
async function idbGet(key) {
    try {
        const db = await idbOpen()
        const tx = db.transaction('handles', 'readonly')
        return await idbRequest(tx.objectStore('handles').get(key))
    } catch (e) {
        RecordError('idbGet', e)
        return null
    }
}

async function PickOutputFolder(kind) {
    kind = kind || 'music'
    if (!unsafeWindow.showDirectoryPicker) {
        alert('Folder selection needs Chrome/Edge (File System Access API).')
        return null
    }
    try {
        const handle = await unsafeWindow.showDirectoryPicker({
            id: 'artlist-dl-' + kind,
            mode: 'readwrite'
        })
        OutputDirHandles[kind] = handle
        await idbSet(OutputKey(kind), handle)
        Notify(`${kind.toUpperCase()} download folder set: ${handle.name}`, 'Artlist DL')
        // sync immediately so newly-rendered buttons turn yellow
        SyncOutputFolder(kind).then(n => {
            if (n) { ReapplyDownloadedStyles(); LogDebug('folder sync on pick: ' + n + ' new IDs') }
        }).catch(e => RecordError('syncOnPick', e))
        return handle
    } catch (e) {
        if (e && e.name === 'AbortError') return null
        RecordError('PickOutputFolder', e)
        return null
    }
}
async function ClearOutputFolder(kind) {
    if (kind) {
        OutputDirHandles[kind] = null
        await idbSet(OutputKey(kind), null)
    } else {
        for (const k of OUTPUT_KINDS) {
            OutputDirHandles[k] = null
            await idbSet(OutputKey(k), null)
        }
    }
    Notify('Download folder cleared — back to Save dialog / zip', 'Artlist DL')
}
async function LoadOutputFolders() {
    for (const kind of OUTPUT_KINDS) {
        const h = await idbGet(OutputKey(kind))
        if (h) OutputDirHandles[kind] = h
    }
    // migrate the old single-folder key (was music-only)
    if (!OutputDirHandles.music) {
        const legacy = await idbGet('outputDir')
        if (legacy) {
            OutputDirHandles.music = legacy
            await idbSet(OutputKey('music'), legacy)
        }
    }
}
async function EnsureFolderPermission(handle) {
    if (!handle) return false
    try {
        const opts = { mode: 'readwrite' }
        if (
            handle.queryPermission &&
            (await handle.queryPermission(opts)) === 'granted'
        ) {
            return true
        }
        if (
            handle.requestPermission &&
            (await handle.requestPermission(opts)) === 'granted'
        ) {
            return true
        }
    } catch (e) {
        RecordError('EnsureFolderPermission', e)
    }
    return false
}
async function GetCategoryDir(rootHandle, segments) {
    let dir = rootHandle
    for (const seg of segments || []) {
        if (!seg) continue
        dir = await dir.getDirectoryHandle(seg, { create: true })
    }
    return dir
}
async function WriteFileToDir(dir, filename, blob) {
    const fh = await dir.getFileHandle(filename, { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
}

// SFX-pack pages: file everything under one folder named after the pack title.
function GetPackTitle() {
    try {
        const h1 = unsafeWindow.document.querySelector('h1')
        if (h1 && h1.textContent.trim()) return h1.textContent.trim()
    } catch (e) {}
    try {
        const parts = unsafeWindow.location.pathname.split('/')
        const slug = parts[3] || parts[parts.length - 1]
        if (slug) return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    } catch (e) {}
    return null
}
// The folder path for a row: SFX packs override genre with the pack name.
function CategoryForRow(audioData, rowElement, pagetype) {
    if (pagetype === SFXP_PAGETYPE) {
        const t = SanitizeFolderName(GetPackTitle() || 'Pack')
        return t ? [t] : []
    }
    return GetCategory(audioData, rowElement)
}

// ---- Minimal ID3v2.3 tag writer (experimental) ----------------------------
function Utf16le(str) {
    const buf = new Uint8Array(str.length * 2)
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)
        buf[i * 2] = c & 0xff
        buf[i * 2 + 1] = (c >> 8) & 0xff
    }
    return buf
}
function ConcatU8(arrays) {
    let len = 0
    for (const a of arrays) len += a.length
    const out = new Uint8Array(len)
    let off = 0
    for (const a of arrays) {
        out.set(a, off)
        off += a.length
    }
    return out
}
function Id3TextFrame(id, text) {
    // text encoding 0x01 = UTF-16 with BOM (ID3v2.3 compliant)
    const bom = new Uint8Array([0xff, 0xfe])
    const content = ConcatU8([
        new Uint8Array([0x01]),
        bom,
        Utf16le(String(text)),
        new Uint8Array([0x00, 0x00])
    ])
    const header = new Uint8Array(10)
    for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i)
    const sz = content.length // ID3v2.3 frame size is a plain 32-bit big-endian int
    header[4] = (sz >>> 24) & 0xff
    header[5] = (sz >>> 16) & 0xff
    header[6] = (sz >>> 8) & 0xff
    header[7] = sz & 0xff
    return ConcatU8([header, content])
}
// APIC frame: cover art (picture type 0x03 = front cover)
function Id3ApicFrame(mime, imageBytes) {
    // APIC: encoding(1) + mime + NUL + picType(1) + desc + NUL NUL + data
    const enc = new Uint8Array([0x00]) // ISO-8859-1
    const mimeBytes = new TextEncoder().encode(mime)
    const nul1 = new Uint8Array([0x00])
    const picType = new Uint8Array([0x03])
    const desc = new Uint8Array([0x00]) // empty description
    const content = ConcatU8([enc, mimeBytes, nul1, picType, desc, imageBytes])
    const header = new Uint8Array(10)
    const id = 'APIC'
    for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i)
    const sz = content.length
    header[4] = (sz >>> 24) & 0xff
    header[5] = (sz >>> 16) & 0xff
    header[6] = (sz >>> 8) & 0xff
    header[7] = sz & 0xff
    return ConcatU8([header, content])
}
function BuildId3v2(tags, coverArt) {
    const frames = []
    if (tags.title) frames.push(Id3TextFrame('TIT2', tags.title))
    if (tags.artist) frames.push(Id3TextFrame('TPE1', tags.artist))
    if (tags.album) frames.push(Id3TextFrame('TALB', tags.album))
    if (tags.genre) frames.push(Id3TextFrame('TCON', tags.genre))
    if (tags.year) frames.push(Id3TextFrame('TDRC', tags.year))
    if (tags.bpm) frames.push(Id3TextFrame('TBPM', tags.bpm))
    if (tags.trackNum) frames.push(Id3TextFrame('TRCK', tags.trackNum))
    if (coverArt && coverArt.bytes && coverArt.mime) {
        try { frames.push(Id3ApicFrame(coverArt.mime, coverArt.bytes)) } catch (e) {}
    }
    if (!frames.length) return new Uint8Array(0)
    const body = ConcatU8(frames)
    const header = new Uint8Array(10)
    header[0] = 0x49 // 'I'
    header[1] = 0x44 // 'D'
    header[2] = 0x33 // '3'
    header[3] = 0x03 // version 2.3
    header[4] = 0x00
    header[5] = 0x00 // flags
    const size = body.length // tag size is a synchsafe integer (7 bits per byte)
    header[6] = (size >>> 21) & 0x7f
    header[7] = (size >>> 14) & 0x7f
    header[8] = (size >>> 7) & 0x7f
    header[9] = size & 0x7f
    return ConcatU8([header, body])
}

// Minimal Vorbis comment block for FLAC/WAV — prepended before the audio stream.
// Format: vendor string (4-byte LE len + bytes) + comment count (4-byte LE) + comments.
function BuildVorbisComment(tags) {
    const enc = new TextEncoder()
    function vlstr(s) {
        const b = enc.encode(s)
        const len = new Uint8Array(4)
        new DataView(len.buffer).setUint32(0, b.length, true)
        return ConcatU8([len, b])
    }
    const vendor = vlstr('Artlist DL')
    const pairs = []
    if (tags.title)  pairs.push('TITLE=' + tags.title)
    if (tags.artist) pairs.push('ARTIST=' + tags.artist)
    if (tags.album)  pairs.push('ALBUM=' + tags.album)
    if (tags.genre)  pairs.push('GENRE=' + tags.genre)
    if (tags.year)   pairs.push('DATE=' + tags.year)
    if (tags.bpm)    pairs.push('BPM=' + tags.bpm)
    const countBuf = new Uint8Array(4)
    new DataView(countBuf.buffer).setUint32(0, pairs.length, true)
    const commentParts = [vendor, countBuf]
    for (const p of pairs) commentParts.push(vlstr(p))
    return ConcatU8(commentParts)
}

// Fetch cover art via GM_xmlhttpRequest to bypass CORS
async function FetchCoverArt(url) {
    if (!url) return null
    return new Promise(resolve => {
        try {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'arraybuffer',
                    onload: r => {
                        try {
                            let mime = 'image/jpeg'
                            const m = (r.responseHeaders || '').match(/content-type:\s*([^\r\n]+)/i)
                            if (m) mime = m[1].trim().split(';')[0].trim()
                            resolve({ mime, bytes: new Uint8Array(r.response) })
                        } catch (e) { resolve(null) }
                    },
                    onerror: () => resolve(null)
                })
            } else { resolve(null) }
        } catch (e) { resolve(null) }
    })
}

function CanEmbedTags(ext) {
    return ext === 'mp3' || ext === 'aac' || ext === 'flac' || ext === 'wav'
}
async function MaybeEmbedTags(blob, ext, tags) {
    if (!GetSetting('embedTags') || !tags || !CanEmbedTags(ext)) return blob
    try {
        let coverArt = null
        if (GetSetting('embedCoverArt') && tags.coverUrl) {
            coverArt = await FetchCoverArt(tags.coverUrl)
        }
        const audioBytes = new Uint8Array(await blob.arrayBuffer())
        if (ext === 'flac' || ext === 'wav') {
            const commentBytes = BuildVorbisComment(tags)
            if (!commentBytes.length) return blob
            return new Blob([ConcatU8([commentBytes, audioBytes])], {
                type: blob.type || MimeForExt(ext)
            })
        }
        const tagBytes = BuildId3v2(tags, coverArt)
        if (!tagBytes.length) return blob
        return new Blob([ConcatU8([tagBytes, audioBytes])], {
            type: blob.type || MimeForExt(ext)
        })
    } catch (e) {
        RecordError('MaybeEmbedTags', e, tags)
        return blob
    }
}

// ---- Local folder sync — scan output folders and mark existing files yellow -
//
// Two matching strategies, applied in order:
//   1. ID-based (fast, exact): filename ends with "(artistId.albumId.songId)"
//      e.g.  Music Artist - Title (123.456.789).mp3
//   2. Name-based (fuzzy, primary): parse "{type} {artist} - {title ...}.ext"
//      e.g.  Music Ariel Shalom - AURAX93.aac  →  artist="ariel shalom" title="aurax93"
//      Matched against live audio data when WriteAudio/WriteBanner runs.
//
// ScannedFiles holds normalized "artist:::title" keys extracted from filenames.
// When WriteAudio encounters a track, it checks ScannedFiles and marks it downloaded.

const LOCAL_ID_RE = /\((\d+\.(?:\d+\.)?\d+)\)(?:\.[a-z0-9]+)?$/i
const AUDIO_EXT_RE = /\.(mp3|aac|m4a|wav|flac|ogg|webm)$/i
const SCAN_TYPE_PREFIXES = ['music stem ', 'music ', 'sfx ']

// In-memory index of files found on disk — cleared and rebuilt on each scan.
// Keys: NormalizeForMatch(artist) + ':::' + NormalizeForMatch(title)
let ScannedFiles = new Set()
// How many audio files the last scan found (regardless of ID match)
let _lastSyncFileCount = 0
let _lastSyncCount = { music: 0, sfx: 0, ts: null }

function NormalizeForMatch(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

// Extract artist:::title keys from a single audio filename.
// Returns an array of 1-2 normalized keys:
//   [ "artist:::titlewithalubm", "artist:::titleonly" ]
function ParseFilenameKeys(filename) {
    // Strip extension
    let base = filename.replace(/\.[a-z0-9]+$/i, '').trim()
    // Strip trailing (id.id.id) block if present
    base = base.replace(/\s*\(\d+\.(?:\d+\.)?\d+\)\s*$/, '').trim()
    // Remove type prefix (case-insensitive)
    const lower = base.toLowerCase()
    for (const prefix of SCAN_TYPE_PREFIXES) {
        if (lower.startsWith(prefix)) {
            base = base.slice(prefix.length).trim()
            break
        }
    }
    // Must contain " - " to split artist from title
    const dashIdx = base.indexOf(' - ')
    if (dashIdx < 1) return []
    const artistPart = base.slice(0, dashIdx).trim()
    const titleFull = base.slice(dashIdx + 3).trim()
    const a = NormalizeForMatch(artistPart)
    if (!a) return []
    const keys = []
    // Key 1: full title part (may contain "on Album")
    const t1 = NormalizeForMatch(titleFull)
    if (t1) keys.push(a + ':::' + t1)
    // Key 2: title-only — strip trailing " on Something" if present
    const onIdx = titleFull.search(/\s+on\s+\S/i)
    if (onIdx > 0) {
        const t2 = NormalizeForMatch(titleFull.slice(0, onIdx))
        if (t2 && t2 !== t1) keys.push(a + ':::' + t2)
    }
    return keys
}

// Build the lookup keys for a given AudioData object (called from WriteAudio).
function AudioDataKeys(audioData) {
    if (!audioData) return []
    const a = NormalizeForMatch(audioData.artistName)
    if (!a) return []
    const songName = audioData._songName || audioData.songName || ''
    const albumName = audioData._albumName || audioData.albumName || ''
    const keys = []
    const t1 = NormalizeForMatch(songName)
    if (t1) keys.push(a + ':::' + t1)
    // Also try "title on album" composite — how MakeFilename builds the album part
    if (albumName && albumName !== songName) {
        const t2 = NormalizeForMatch(songName + ' on ' + albumName)
        if (t2) keys.push(a + ':::' + t2)
    }
    return keys
}

function IsInScannedFiles(audioData) {
    if (!ScannedFiles.size) return false
    for (const key of AudioDataKeys(audioData)) {
        if (ScannedFiles.has(key)) return true
    }
    return false
}

// Recursively iterate a FileSystemDirectoryHandle, collecting:
//   found    — Set of compound IDs from filenames with (id) suffix
//   (side-effect) ScannedFiles — normalized artist:::title keys from all audio files
async function ScanFolderForIds(dirHandle, found) {
    if (!found) found = new Set()
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            try {
                if (handle.kind === 'directory') {
                    await ScanFolderForIds(handle, found)
                } else if (handle.kind === 'file' && AUDIO_EXT_RE.test(name)) {
                    _lastSyncFileCount++
                    // Strategy 1: ID in filename
                    const m = name.match(LOCAL_ID_RE)
                    if (m) found.add(m[1])
                    // Strategy 2: Parse artist + title into ScannedFiles
                    for (const key of ParseFilenameKeys(name)) ScannedFiles.add(key)
                }
            } catch (e) { /* skip inaccessible entry */ }
        }
    } catch (e) {
        RecordError('ScanFolderForIds', e)
    }
    return found
}

// Scan one output folder kind ('music' or 'sfx').
// Returns the number of IDs that were newly added to DownloadedIds via the ID strategy.
// Name-based matches are deferred to WriteAudio/WriteBanner (real-time, as page data loads).
async function SyncOutputFolder(kind) {
    const handle = OutputDirHandles[kind || 'music']
    if (!handle) return 0
    try {
        const perm = await handle.queryPermission({ mode: 'read' })
        if (perm !== 'granted') {
            const wperm = await handle.queryPermission({ mode: 'readwrite' })
            if (wperm !== 'granted') return 0
        }
    } catch (e) { return 0 }
    const ids = await ScanFolderForIds(handle)
    let newCount = 0
    for (const id of ids) {
        if (!DownloadedIds.has(id)) {
            DownloadedIds.set(id, { ts: new Date().toISOString(), source: 'folder-scan' })
            newCount++
        }
    }
    _lastSyncCount[kind] = (_lastSyncCount[kind] || 0) + newCount
    if (newCount) _saveDownloaded()
    return newCount
}

// Scan both folders, rebuild ScannedFiles, then re-apply yellow styles.
// Returns count of newly marked IDs (ID strategy); name-based matches happen
// lazily in WriteAudio as Artlist page data loads.
async function SyncAllOutputFolders() {
    ScannedFiles = new Set()
    _lastSyncFileCount = 0
    const music = await SyncOutputFolder('music')
    const sfx = await SyncOutputFolder('sfx')
    _lastSyncCount.ts = new Date().toISOString()
    ReapplyDownloadedStyles()
    LogDebug('folder sync: music=' + music + ' sfx=' + sfx + ' files=' + _lastSyncFileCount + ' keys=' + ScannedFiles.size)
    return music + sfx
}

// Re-apply yellow to already-rendered buttons after a scan.
// Checks both DownloadedIds (ID match) and ScannedFiles (name match via stored key).
function ReapplyDownloadedStyles() {
    try {
        for (const btn of unsafeWindow.document.querySelectorAll('[data-artlist-dl-id],[data-artlist-dl-key]')) {
            const id = btn.getAttribute('data-artlist-dl-id')
            const key = btn.getAttribute('data-artlist-dl-key')
            if ((id && IsDownloaded(id)) || (key && ScannedFiles.has(key))) {
                ApplyDownloadedStyle(btn)
                // If we matched by name and have an id, persist it now
                if (key && ScannedFiles.has(key) && id && !IsDownloaded(id)) {
                    DownloadedIds.set(id, { ts: new Date().toISOString(), source: 'name-match' })
                    _saveDownloaded()
                }
            }
        }
    } catch (e) {
        RecordError('ReapplyDownloadedStyles', e)
    }
}

// ---- Folder quick-open via local Python helper (artlist_helper.py) ---------
// The Python script runs a tiny HTTP server on 127.0.0.1:7842.  When we POST
// a path it calls os.startfile(path) which opens Windows Explorer / Finder
// directly at the exact subfolder.  No browser picker, no file:// URL issues.
const HELPER_PORT = 7842
const HELPER_ORIGIN = 'http://127.0.0.1:' + HELPER_PORT

// Build the full OS path from the stored base + subfolder segments.
function BuildFullPath(kind, categorySegments) {
    const base = (GetSetting('folderPath.' + kind) || '').trim()
    if (!base) return null
    // Detect OS separator from the stored path
    const sep = base.includes('\\') ? '\\' : '/'
    const parts = [base.replace(/[/\\]+$/, ''), ...(categorySegments || []).filter(Boolean)]
    return parts.join(sep)
}
function HasFolderPath(kind) {
    return !!(GetSetting('folderPath.' + kind) || '').trim()
}

// Returns true if the helper responds to /ping within 1 second.
function CheckHelper() {
    return new Promise(resolve => {
        if (typeof GM_xmlhttpRequest === 'undefined') { resolve(false); return }
        GM_xmlhttpRequest({
            method: 'GET', url: HELPER_ORIGIN + '/ping',
            timeout: 1000,
            onload: r => resolve(r.status === 200 && r.responseText === 'artlist-dl-helper'),
            onerror: () => resolve(false), ontimeout: () => resolve(false)
        })
    })
}

// Opens the folder in the OS file manager via the local helper.
// Resolves { ok, notFound } — notFound distinguishes "path doesn't exist on
// disk" (stale/mismatched setting) from "helper isn't reachable at all",
// so the UI can point at the right fix instead of a generic error.
function OpenFolderViaHelper(kind, categorySegments) {
    return new Promise(resolve => {
        const fullPath = BuildFullPath(kind, categorySegments)
        if (!fullPath) { resolve({ ok: false, notFound: false }); return }
        if (typeof GM_xmlhttpRequest === 'undefined') { resolve({ ok: false, notFound: false }); return }
        GM_xmlhttpRequest({
            method: 'GET',
            url: HELPER_ORIGIN + '/open?path=' + encodeURIComponent(fullPath),
            // Generous: when no window exists yet the helper spawns Explorer and
            // waits up to 3 s to find and raise the window it made. Timing out
            // early here would report a failure for a folder that did open, and
            // send the user chasing the wrong fix.
            timeout: 6000,
            onload: r => resolve({ ok: r.status === 200, notFound: r.status === 404 }),
            onerror: () => resolve({ ok: false, notFound: false }),
            ontimeout: () => resolve({ ok: false, notFound: false })
        })
    })
}

// ---- Folder open without the Python helper ----------------------------------
// Chrome blocks a *webpage* from navigating to file:// via window.open() —
// that's the real limitation. GM_openInTab goes through Tampermonkey's own
// privileged tab-creation API instead of page-context navigation, so it isn't
// subject to that block and needs no local process running. One-time caveat:
// the user must enable "Allow access to file URLs" for the Tampermonkey
// extension in chrome://extensions, or the created tab renders blank/blocked.
let HelperAvailable = false // set by the page-load ping in the lifecycle IIFE below

function BuildFileUrl(fullPath) {
    if (!fullPath) return null
    const norm = fullPath.replace(/\\/g, '/')
    const encoded = norm.split('/').map(encodeURIComponent).join('/')
    const withDriveColon = encoded.replace(/^([A-Za-z])%3A/, '$1:') // keep "C:" readable
    return withDriveColon.startsWith('/') ? 'file://' + withDriveColon : 'file:///' + withDriveColon
}

// GM_openInTab doesn't report whether the tab actually opened — Chrome silently
// drops file:// tab creation from an extension that lacks "Allow access to file
// URLs", with no exception thrown on our end. So this doesn't just trust the
// call: it waits briefly to see whether *this* tab actually loses focus, which
// only happens if a new active tab really took over. No signal within the
// window means treat it as failed so the caller can fall back to something
// that's guaranteed to work (the inline file list).
function OpenFolderInFileTab(kind, categorySegments) {
    if (typeof GM_openInTab === 'undefined') return Promise.resolve(false)
    const url = BuildFileUrl(BuildFullPath(kind, categorySegments))
    if (!url) return Promise.resolve(false)
    return new Promise(resolve => {
        let settled = false
        const finish = ok => {
            if (settled) return
            settled = true
            document.removeEventListener('visibilitychange', onVisible)
            resolve(ok)
        }
        const onVisible = () => { if (document.hidden) finish(true) }
        document.addEventListener('visibilitychange', onVisible)
        try {
            GM_openInTab(url, { active: true, insert: true, setParent: true })
        } catch (e) {
            RecordError('OpenFolderInFileTab', e, { url })
            finish(false)
            return
        }
        setTimeout(() => finish(false), 1200)
    })
}

// ---- Starting the helper from the page --------------------------------------
// Chrome only hands a page to an external protocol handler while that page has
// *user activation*. A load-time unsafeWindow.open('artlist://start') is
// swallowed by the popup blocker before it ever reaches the protocol layer, so
// the "Allow artlist.io to open Artlist DL Helper?" prompt never appears and
// the helper never comes up — which left every "Open folder" falling through to
// the file:// tab. Firing it from inside a real click is what makes it work.
//
// MUST be called synchronously from a click handler: any await before it drops
// the activation and puts us back in the silently-blocked case.
function RequestHelperStart() {
    try {
        const w = unsafeWindow.open('artlist://start', '_blank')
        if (w) { try { w.close() } catch (e) {} }
        return true
    } catch (e) {
        RecordError('RequestHelperStart', e)
        return false
    }
}

// A download click is the other moment the page holds user activation, so use it
// to bring the helper up *before* the save finishes and auto-open needs it. The
// login entry and the watchdog normally have it running already, which makes this
// a no-op; it only fires in the gap after a crash, and at most once a minute so a
// dead helper can't turn every click into a prompt.
//
// MUST be called synchronously from a click handler, before any await.
const HELPER_CLICK_LAUNCH_COOLDOWN_MS = 60000
let _lastClickLaunch = 0
function StartHelperOnClick() {
    if (HelperAvailable) return
    if (typeof GetSetting === 'function' && !GetSetting('autoOpenFolder')) return
    const now = Date.now()
    if (now - _lastClickLaunch < HELPER_CLICK_LAUNCH_COOLDOWN_MS) return
    _lastClickLaunch = now
    RequestHelperStart()
}

// Poll /ping until the helper answers or we run out of patience. pythonw's
// first start on a cold cache is comfortably slower than a single check.
async function WaitForHelper(maxMs) {
    const deadline = Date.now() + (maxMs || 4000)
    while (Date.now() < deadline) {
        if (await CheckHelper()) { HelperAvailable = true; return true }
        await new Promise(r => setTimeout(r, 400))
    }
    return false
}

// The page-load ping is a hint, not a verdict — the helper is routinely started
// *after* the first tab opens (logon task still running, user launched it by
// hand, or the click above just brought it up). Latching that first "no" for
// the whole session was the reason a perfectly healthy helper still never got
// used. Re-probe on demand, rate-limited so a dead helper doesn't cost a
// timeout on every single download.
const HELPER_REPROBE_MS = 5000
let _lastHelperProbe = 0
async function EnsureHelper() {
    if (HelperAvailable) return true
    const now = Date.now()
    if (now - _lastHelperProbe < HELPER_REPROBE_MS) return false
    _lastHelperProbe = now
    HelperAvailable = await CheckHelper()
    return HelperAvailable
}

// Tries the Python helper (real Explorer/Finder window), then falls back to the
// file:// tab, which needs nothing running — just the full path pasted once in
// settings, plus Tampermonkey's "Allow access to file URLs".
// `reason` tells the caller which advice to show when it fails.
async function OpenSaveFolder(kind, categorySegments) {
    if (await EnsureHelper()) {
        const { ok, notFound } = await OpenFolderViaHelper(kind, categorySegments)
        if (ok) return { ok: true, notFound: false, reason: null }
        if (notFound) return { ok: false, notFound: true, reason: 'not-found' }
        HelperAvailable = false // answered /ping but not /open — treat as gone
    }
    const ok = await OpenFolderInFileTab(kind, categorySegments)
    return { ok, notFound: false, reason: ok ? null : (HelperAvailable ? 'file-blocked' : 'no-helper') }
}

// ---- Auto-open debounce ------------------------------------------------------
// A bulk download only shows one toast for the whole batch, so that's already
// safe. This guards the other case: several *separate* single-track downloads
// to the same folder within a few seconds — without it, each would pop its own
// Explorer window. Re-opening the same path is a no-op while the cooldown holds;
// a different path (or the manual button) always goes through immediately.
const AUTO_OPEN_COOLDOWN_MS = 4000
let _lastAutoOpenPath = null
let _lastAutoOpenTs = 0
function ShouldAutoOpen(fullPath) {
    const now = Date.now()
    if (fullPath && fullPath === _lastAutoOpenPath && (now - _lastAutoOpenTs) < AUTO_OPEN_COOLDOWN_MS) {
        return false
    }
    _lastAutoOpenPath = fullPath
    _lastAutoOpenTs = now
    return true
}

// ---- "Saved" toast (bottom-right above gear, fades after 5 s) ---------------
// Primary: if user set a base path, GM_openInTab opens Chrome's file browser there.
// Fallback: list files inline using the FileSystemDirectoryHandle.
const SAVED_TOAST_MS = 5000

function ShowSavedToast(displayPath, rootHandle, categorySegments, kind) {
    try { const o = unsafeWindow.document.getElementById('artlist-dl-saved-toast'); if (o) o.remove() } catch (e) {}
    if (!document.body) return

    const host = document.createElement('div')
    host.id = 'artlist-dl-saved-toast'
    const shadow = host.attachShadow({ mode: 'open' })
    document.body.appendChild(host)

    const styleEl = document.createElement('style')
    styleEl.textContent = `
* { box-sizing: border-box; font-family: 'Poppins','Segoe UI',system-ui,sans-serif; }
.toast {
  position: fixed; bottom: 220px; right: 20px; z-index: 2147483647;
  background: #131313; border: 1px solid #252525; border-radius: 12px;
  padding: 13px 14px 11px; max-width: 310px; min-width: 200px;
  box-shadow: 0 6px 28px rgba(0,0,0,.6);
  display: flex; align-items: flex-start; gap: 10px;
  opacity: 0; transform: translateY(8px);
  transition: opacity .22s ease, transform .22s ease;
}
.toast.in  { opacity: 1; transform: translateY(0); }
.toast.out { opacity: 0; transform: translateY(8px); }
.check { color: #82ff59; font-size: 18px; flex: 0 0 auto; line-height: 1; padding-top: 2px; }
.body  { flex: 1; min-width: 0; }
.label { font-size: 12.5px; font-weight: 600; color: #f0f0f0; }
.path  { font-size: 10.5px; color: #666; margin-top: 3px;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  margin-top: 9px; background: #1d1d1d; border: 1px solid #2e2e2e;
  color: #bbb; border-radius: 7px; padding: 5px 11px; font-size: 11.5px;
  cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 5px;
  transition: background .15s, color .15s, border-color .15s;
}
.btn:hover:not(:disabled) { background: #242424; border-color: #f5d90a; color: #f5d90a; }
.btn:disabled { opacity: .5; cursor: default; }
.file-list { margin-top: 9px; display: flex; flex-direction: column; gap: 4px; }
.file-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; color: #c8c8c8; padding: 3px 6px;
  background: #1a1a1a; border-radius: 5px; overflow: hidden;
}
.file-icon { flex: 0 0 auto; font-size: 12px; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-more { font-size: 10px; color: #555; padding: 2px 6px; }
.timer { height: 2px; background: #202020; border-radius: 1px; margin-top: 10px; overflow: hidden; }
.bar   { height: 100%; background: #f5d90a; border-radius: 1px; width: 100%; }
.x { background: none; border: none; color: #444; font-size: 13px; cursor: pointer;
     padding: 0; flex: 0 0 auto; line-height: 1; align-self: flex-start; margin-top: 2px; }
.x:hover { color: #ccc; }
`
    shadow.appendChild(styleEl)

    const toast = document.createElement('div')
    toast.className = 'toast'

    const checkEl = document.createElement('span')
    checkEl.className = 'check'
    checkEl.textContent = '✓'

    const bodyEl = document.createElement('div')
    bodyEl.className = 'body'

    const labelEl = document.createElement('div')
    labelEl.className = 'label'
    labelEl.textContent = 'Saved'
    bodyEl.appendChild(labelEl)

    if (displayPath) {
        const pathEl = document.createElement('div')
        pathEl.className = 'path'
        pathEl.textContent = displayPath
        pathEl.title = displayPath
        bodyEl.appendChild(pathEl)
    }

    // "Open folder" button:
    //   • If a full OS path is set in Settings → auto-opens the moment the toast
    //     appears (Python helper if it's already running, otherwise a Chrome
    //     file:// tab via GM_openInTab — no helper/process required either way).
    //     The button just re-triggers it, or explains why it couldn't.
    //   • Otherwise → auto-lists files inline via the already-granted
    //     FileSystemDirectoryHandle (also automatic, no click needed).
    const canDirectOpen = kind && HasFolderPath(kind)
    const fullPath = canDirectOpen ? BuildFullPath(kind, categorySegments) : null
    let btn = null
    let timerElRef = null // wired up once the timer bar element exists, below

    const showHint = (text, color) => {
        const hint = document.createElement('div')
        hint.className = 'file-more'
        hint.style.color = color || '#f5a623'
        hint.textContent = text
        bodyEl.insertBefore(hint, timerElRef)
    }

    // When the folder can't be *opened*, the next best thing is handing the user
    // the exact path so one paste into an Explorer address bar gets them there.
    const showCopyPathRow = () => {
        if (!fullPath) return
        const b = document.createElement('button')
        b.className = 'btn'
        b.style.marginTop = '6px'
        b.textContent = '📋 Copy folder path'
        b.title = fullPath
        b.addEventListener('click', () => {
            try {
                if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(fullPath, 'text')
                else navigator.clipboard.writeText(fullPath)
                b.textContent = '✓ Path copied — paste in Explorer'
            } catch (e) {
                RecordError('showCopyPathRow', e)
            }
        })
        bodyEl.insertBefore(b, timerElRef)
    }

    const listFilesInline = async () => {
        if (!rootHandle) return false
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…' }
        try {
            let dirHandle = rootHandle
            for (const seg of (categorySegments || [])) {
                dirHandle = await dirHandle.getDirectoryHandle(seg)
            }
            const files = []
            for await (const [name, entry] of dirHandle.entries()) {
                if (entry.kind === 'file') files.push(name)
            }
            files.sort()
            if (btn) { btn.remove(); btn = null }
            if (!files.length) { showHint('(folder is empty)', '#666'); return true }
            const list = document.createElement('div')
            list.className = 'file-list'
            const SHOW = 6
            for (const name of files.slice(0, SHOW)) {
                const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
                const icon = ['ts','mp4','mov'].includes(ext) ? '🎬'
                    : ['mp3','aac','wav','flac','ogg','m4a'].includes(ext) ? '🔊' : '📄'
                const row = document.createElement('div')
                row.className = 'file-row'
                const iconEl = document.createElement('span')
                iconEl.className = 'file-icon'; iconEl.textContent = icon
                const nameEl = document.createElement('span')
                nameEl.className = 'file-name'
                nameEl.textContent = name; nameEl.title = name
                row.appendChild(iconEl); row.appendChild(nameEl)
                list.appendChild(row)
            }
            if (files.length > SHOW) {
                const more = document.createElement('div')
                more.className = 'file-more'
                more.textContent = `+ ${files.length - SHOW} more`
                list.appendChild(more)
            }
            bodyEl.insertBefore(list, timerElRef)
            return true
        } catch (err) {
            if (btn) { btn.disabled = false; btn.textContent = '📂 Show files' }
            RecordError('ShowSavedToast.listFilesInline', err)
            showHint('Could not list files — ' + (err && err.message ? err.message : String(err)))
            return false
        }
    }

    // Shared by the automatic trigger and the manual button click.
    // `viaClick` means the listener below already fired artlist://start inside
    // the gesture, so it's worth waiting for the helper to finish booting
    // before writing it off and dropping to the file:// tab.
    const openFolder = async (viaClick) => {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Opening…' }
        if (viaClick && !HelperAvailable) await WaitForHelper(4000)
        const { ok, notFound, reason } = await OpenSaveFolder(kind, categorySegments)
        if (btn) {
            btn.disabled = false
            btn.textContent = ok ? '✓ Opened' : '📂 Open folder'
        }
        if (ok) return true
        // Each failure has a different fix, and pointing at the wrong one costs
        // the user an evening — so say which one actually applies.
        if (notFound) {
            showHint('Folder is not on disk: ' + fullPath + ' — fix the path under Settings → Download folders')
        } else if (reason === 'no-helper') {
            showHint('Helper not running. Click "Open folder" and choose Open when Chrome asks to launch Artlist DL Helper — or run setup_autostart.bat once so it starts with Windows.')
            showCopyPathRow()
        } else {
            showHint('Chrome blocked opening the folder tab. Enable it once: chrome://extensions → Tampermonkey → Details → "Allow access to file URLs".')
            showCopyPathRow()
        }
        if (rootHandle) await listFilesInline()
        return false
    }

    if (canDirectOpen || rootHandle) {
        btn = document.createElement('button')
        btn.className = 'btn'
        btn.textContent = canDirectOpen ? '📂 Open folder' : '📂 Show files'
        btn.title = canDirectOpen
            ? 'Opens the saved folder — via the helper if running, otherwise a browser tab'
            : 'Lists the saved files right here (paste a full path in Settings for real folder open)'
        btn.addEventListener('click', () => {
            if (!canDirectOpen) { listFilesInline(); return }
            // Synchronous, before any await — this is the only moment the page
            // still has the user activation Chrome requires to launch
            // artlist://. Skipped when the helper already answered a ping, so
            // the permission prompt only shows up when it's actually needed.
            if (!HelperAvailable) RequestHelperStart()
            openFolder(true)
        })
        bodyEl.appendChild(btn)
    }

    const timerEl = document.createElement('div')
    timerEl.className = 'timer'
    const barEl = document.createElement('div')
    barEl.className = 'bar'
    timerEl.appendChild(barEl)
    bodyEl.appendChild(timerEl)
    timerElRef = timerEl

    const xBtn = document.createElement('button')
    xBtn.className = 'x'
    xBtn.textContent = '✕'

    toast.appendChild(checkEl)
    toast.appendChild(bodyEl)
    toast.appendChild(xBtn)
    shadow.appendChild(toast)

    // Auto-open: fires the moment the toast lands, no click needed. The
    // debounce only applies to the real-folder path (helper/file tab) — it
    // guards against several *separate* single-track downloads to the same
    // folder each popping their own window; it doesn't apply to the inline
    // list, which is scoped to its own toast and never spawns anything.
    if (GetSetting('autoOpenFolder')) {
        if (canDirectOpen) {
            // No user activation here, so no artlist:// launch — this path
            // relies on the helper already running (the logon task's job).
            if (ShouldAutoOpen(fullPath)) openFolder(false)
        } else if (rootHandle) {
            listFilesInline()
        }
    }

    requestAnimationFrame(() => {
        toast.classList.add('in')
        barEl.style.transition = `width ${SAVED_TOAST_MS}ms linear`
        requestAnimationFrame(() => { barEl.style.width = '0%' })
    })

    let dismissed = false
    const dismiss = () => {
        if (dismissed) return
        dismissed = true
        toast.classList.remove('in')
        toast.classList.add('out')
        setTimeout(() => { try { host.remove() } catch (e) {} }, 280)
    }
    const autoTimer = setTimeout(dismiss, SAVED_TOAST_MS)
    xBtn.addEventListener('click', () => { clearTimeout(autoTimer); dismiss() })
}

// ---- Saving (shared by single + bulk) -------------------------------------
async function SaveBlob(blob, filename, types) {
    try {
        if (unsafeWindow.showSaveFilePicker) {
            const handle = await unsafeWindow.showSaveFilePicker({
                suggestedName: filename,
                types: types
            })
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
        } else {
            const blobURL = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = blobURL
            a.download = filename
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(blobURL)
        }
        return true
    } catch (e) {
        if (e && e.name === 'AbortError') return false // user cancelled the picker
        throw e
    }
}

// ---- Concurrency-limited download pool (kept as low-level primitive) --------
async function RunPool(items, limit, worker) {
    const queue = items.slice()
    const runnerCount = Math.max(1, Math.min(limit, queue.length))
    const runners = []
    for (let i = 0; i < runnerCount; i++) {
        runners.push(
            (async () => {
                while (queue.length) {
                    const item = queue.shift()
                    try {
                        await worker(item)
                    } catch (e) {
                        RecordError('RunPool.worker', e, item)
                    }
                }
            })()
        )
    }
    await Promise.all(runners)
}

// ---- DownloadQueue: pause / resume / cancel / retry -----------------------
// Each item: { URL, baseName, tags, category, status:'pending'|'downloading'|'done'|'failed', error, tries }
class DownloadQueue {
    constructor(items, { concurrency, retryCount, onProgress, onDone } = {}) {
        this._items = items.map(it => ({ ...it, status: 'pending', tries: 0 }))
        this._concurrency = Clamp(concurrency || 3, 1, 8)
        this._retryMax = Clamp(retryCount || 0, 0, 5)
        this._paused = false
        this._cancelled = false
        this._onProgress = onProgress || (() => {})
        this._onDone = onDone || (() => {})
        this._resolveAll = null
        this._active = 0
        this._pendingQueue = []
        this._pausePromise = null
        this._pauseResolve = null
    }
    get items() { return this._items }
    get counts() {
        const c = { total: this._items.length, done: 0, failed: 0, active: 0, pending: 0 }
        for (const it of this._items) {
            if (it.status === 'done') c.done++
            else if (it.status === 'failed') c.failed++
            else if (it.status === 'downloading') c.active++
            else c.pending++
        }
        return c
    }
    pause() { this._paused = true; this._pausePromise = new Promise(r => { this._pauseResolve = r }) }
    resume() {
        this._paused = false
        if (this._pauseResolve) { this._pauseResolve(); this._pauseResolve = null }
    }
    cancel() { this._cancelled = true; this.resume() }
    retryFailed() {
        for (const it of this._items) {
            if (it.status === 'failed') { it.status = 'pending'; it.tries = 0; it.error = null }
        }
        this._startWorkers()
    }
    async _waitIfPaused() {
        while (this._paused && !this._cancelled) await this._pausePromise
    }
    async _processItem(item) {
        if (this._cancelled) return
        await this._waitIfPaused()
        if (this._cancelled) return
        item.status = 'downloading'
        this._onProgress()
        try {
            await this._worker(item)
            item.status = 'done'
        } catch (e) {
            item.tries = (item.tries || 0) + 1
            if (item.tries <= this._retryMax) {
                item.status = 'pending'
                this._pendingQueue.push(item)
            } else {
                item.status = 'failed'
                item.error = e && e.message ? e.message : String(e)
                RecordError('DownloadQueue.item', e, { baseName: item.baseName })
            }
        }
        this._onProgress()
    }
    _startWorkers() {
        if (this._cancelled) return
        while (this._active < this._concurrency && this._pendingQueue.length) {
            const item = this._pendingQueue.shift()
            this._active++
            this._processItem(item).finally(() => {
                this._active--
                if (!this._cancelled) this._startWorkers()
                if (this._active === 0 && this._pendingQueue.length === 0) {
                    if (this._resolveAll) this._resolveAll()
                }
            })
        }
        if (this._active === 0 && this._pendingQueue.length === 0 && this._resolveAll) {
            this._resolveAll()
        }
    }
    run(worker) {
        this._worker = worker
        this._pendingQueue = this._items.filter(it => it.status === 'pending')
        return new Promise(resolve => {
            this._resolveAll = resolve
            this._startWorkers()
        })
    }
}

// ---- Enhanced progress overlay (interactive, per-track list) ---------------
function CreateProgressOverlay(queue) {
    const usePerTrack = GetSetting('showPerTrackProgress')
    const host = document.createElement('div')
    host.setAttribute('data-artlist-dl', 'progress')
    const shadow = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = `
* { box-sizing: border-box; font-family: system-ui, sans-serif; }
.wrap {
  position: fixed; bottom: 70px; right: 20px; z-index: 2147483647;
  background: #1b1b1b; color: #82ff59; border: 1px solid #82ff59;
  border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.5);
  width: 300px; overflow: hidden; font-size: 13px;
}
.head { padding: 9px 12px; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; }
.summary { flex: 1; font-weight: 600; }
.ctrl { background: #262626; border: 1px solid #3a3a3a; color: #ccc; border-radius: 6px;
  padding: 3px 9px; font-size: 11px; cursor: pointer; }
.ctrl:hover { background: #333; color: #fff; }
.ctrl.accent { background: #82ff59; border-color: #82ff59; color: #111; font-weight: 600; }
.ctrl.danger { background: #3a1f1f; border-color: #5b2b2b; color: #ff8f8f; }
.list { max-height: 180px; overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.list::-webkit-scrollbar { width: 6px; }
.list::-webkit-scrollbar-thumb { background: #333; border-radius: 6px; }
.track { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 5px; }
.track.done { color: #82ff59; }
.track.failed { color: #ff6666; }
.track.downloading { color: #f5d90a; }
.track.pending { color: #666; }
.ticon { width: 14px; text-align: center; flex: 0 0 auto; font-size: 11px; }
.tname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.tbar-wrap { width: 40px; flex: 0 0 auto; background: #2a2a2a; border-radius: 3px; height: 4px; overflow: hidden; }
.tbar { height: 100%; background: currentColor; transition: width .2s; }
.foot { padding: 6px 12px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #888; text-align: center; }
.simple { padding: 10px 14px; }
`
    shadow.appendChild(style)

    const wrap = document.createElement('div')
    wrap.className = 'wrap'
    shadow.appendChild(wrap)

    const head = document.createElement('div')
    head.className = 'head'
    const summaryEl = document.createElement('span')
    summaryEl.className = 'summary'
    summaryEl.textContent = 'Preparing…'
    head.appendChild(summaryEl)

    const pauseBtn = document.createElement('button')
    pauseBtn.className = 'ctrl'
    pauseBtn.textContent = '⏸'
    pauseBtn.title = 'Pause'
    let _paused = false
    pauseBtn.addEventListener('click', () => {
        if (!queue) return
        if (_paused) { queue.resume(); _paused = false; pauseBtn.textContent = '⏸'; pauseBtn.title = 'Pause' }
        else { queue.pause(); _paused = true; pauseBtn.textContent = '▶'; pauseBtn.title = 'Resume' }
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'ctrl danger'
    cancelBtn.textContent = '✕'
    cancelBtn.title = 'Cancel / close'
    cancelBtn.addEventListener('click', () => {
        if (queue) queue.cancel()
        // Always close the box immediately — X is also the "close" control.
        host.remove(); removed = true; finalized = true
    })

    head.appendChild(pauseBtn)
    head.appendChild(cancelBtn)
    wrap.appendChild(head)

    let listEl = null
    if (usePerTrack && queue) {
        listEl = document.createElement('div')
        listEl.className = 'list'
        wrap.appendChild(listEl)
    } else {
        const simple = document.createElement('div')
        simple.className = 'simple'
        simple.textContent = 'Preparing…'
        wrap._simple = simple
        wrap.appendChild(simple)
    }

    const foot = document.createElement('div')
    foot.className = 'foot'
    foot.style.display = 'none'
    wrap.appendChild(foot)

    const target = document.body || document.documentElement
    target.appendChild(host)
    let removed = false
    let finalized = false // set once done()/fail()/close runs, so they're idempotent

    const STATUS_ICON = { pending: '·', downloading: '↓', done: '✓', failed: '✗' }

    function refresh() {
        if (!queue || removed) return
        const c = queue.counts
        const pct = c.total ? Math.round(((c.done + c.failed) / c.total) * 100) : 0
        summaryEl.textContent = `${c.done}/${c.total} done${c.failed ? ' · ' + c.failed + ' failed' : ''}  ${pct}%`
        if (usePerTrack && listEl) {
            listEl.innerHTML = ''
            for (const it of queue.items) {
                const row = document.createElement('div')
                row.className = 'track ' + it.status
                const icon = document.createElement('span')
                icon.className = 'ticon'
                icon.textContent = STATUS_ICON[it.status] || '·'
                const name = document.createElement('span')
                name.className = 'tname'
                name.textContent = it.baseName || it.URL || ''
                name.title = it.error || it.baseName || ''
                const barWrap = document.createElement('div')
                barWrap.className = 'tbar-wrap'
                const bar = document.createElement('div')
                bar.className = 'tbar'
                bar.style.width = it.status === 'done' || it.status === 'downloading' ? '100%' : '0%'
                barWrap.appendChild(bar)
                row.appendChild(icon)
                row.appendChild(name)
                row.appendChild(barWrap)
                listEl.appendChild(row)
            }
        } else if (wrap._simple) {
            wrap._simple.textContent = summaryEl.textContent
        }
    }

    function showRetryBtn() {
        if (removed) return
        const btn = document.createElement('button')
        btn.className = 'ctrl accent'
        btn.textContent = 'Retry failed'
        btn.style.marginLeft = '6px'
        btn.addEventListener('click', () => {
            btn.remove()
            if (queue) queue.retryFailed()
        })
        head.appendChild(btn)
    }

    return {
        update(text) {
            if (removed) return
            summaryEl.textContent = text
            if (wrap._simple) wrap._simple.textContent = text
        },
        refresh,
        showRetryBtn,
        done(text) {
            if (finalized) return
            finalized = true
            summaryEl.textContent = text
            if (wrap._simple) wrap._simple.textContent = text
            foot.textContent = 'Auto-closing…'
            foot.style.display = ''
            // remove unconditionally after the delay (the old code pre-set
            // `removed`, so the timeout guard never fired and the box stuck)
            setTimeout(() => { host.remove(); removed = true }, 4000)
        },
        fail(text) {
            if (finalized) return
            finalized = true
            wrap.style.borderColor = '#ff6666'
            summaryEl.style.color = '#ff6666'
            summaryEl.textContent = text
            if (wrap._simple) wrap._simple.textContent = text
            setTimeout(() => { host.remove(); removed = true }, 6000)
        },
        remove() { if (!removed) { host.remove(); removed = true } }
    }
}

// ---- Bulk download (zip or folder) ----------------------------------------
async function DownloadMany(items, zipName, kind) {
    items = (items || []).filter(it => it && it.URL)
    if (!items.length) {
        Notify('Nothing downloadable found on this page', 'Artlist DL')
        return
    }
    // Decide output mode up front (permission request stays inside click gesture).
    const rootHandle = GetOutputHandle(kind)
    const folderMode = rootHandle ? await EnsureFolderPermission(rootHandle) : false

    const concurrency = Clamp(GetSetting('concurrency'), 1, 8)
    const retryCount = Clamp(GetSetting('retryCount') || 0, 0, 5)
    const zip = folderMode ? null : new JSZip()
    const usedNames = new Set()
    const zipOkRows = [] // log rows held back until the zip is really saved
    let zipClosed = false

    const queue = new DownloadQueue(items, { concurrency, retryCount })
    const overlay = CreateProgressOverlay(queue)
    overlay.update(`Preparing ${items.length} files…`)

    queue._onProgress = () => overlay.refresh()

    try {
        await queue.run(async item => {
            let tagged, ext
            if (item.hls) {
                // Footage: item.URL is the HLS master playlist. Pick a variant by
                // the configured default resolution and concatenate its segments.
                const variants = await GetClipVariants(item.URL)
                const variant = PickHlsVariant(variants, GetSetting('defaultFootageResolution') || '1080p')
                if (!variant) throw new Error('no HLS variant')
                tagged = await DownloadHlsAsBlob(variant.url)
                ext = 'ts'
            } else {
                const { blob, contentType } = await FetchBlob(item.URL)
                ext = GetSetting('autoDetectExtension')
                    ? ExtFromContentType(contentType, item.URL)
                    : 'aac'
                tagged = await MaybeEmbedTags(blob, ext, item.tags)
            }

            let savedName, savedFolder
            if (folderMode) {
                const dir = await GetCategoryDir(rootHandle, item.category)
                savedName = SanitizeFilename(item.baseName || 'audio') + '.' + ext
                savedFolder = (item.category || []).join('/')
                await WriteFileToDir(dir, savedName, tagged)
            } else {
                const prefix =
                    item.category && item.category.length
                        ? item.category.join('/') + '/'
                        : ''
                const base = SanitizeFilename(item.baseName || 'audio')
                let name = prefix + base + '.' + ext
                let n = 2
                while (usedNames.has(name)) name = prefix + base + ' (' + n++ + ').' + ext
                usedNames.add(name)
                zip.file(name, tagged)
                savedName = name
                savedFolder = zipName
            }
            if (item.tags && item.tags.id) MarkDownloaded(item.tags.id, item.tags.title, item.tags.artist, item.tags.album)
            const okRow = {
                ...EntryFromTags(item.tags, item.hls ? 'footage' : kind, savedName, savedFolder),
                status: 'ok'
            }
            if (folderMode) RecordDownload(okRow)
            // Zip mode: a file only counts as saved once the zip is. And a retry
            // that finishes after the zip has been written is not in it, so it must
            // not clear that item's failed row either.
            else if (!zipClosed) zipOkRows.push(okRow)
        })

        // Items that ran out of retries. A later successful retry (the overlay's
        // button, or the History card) replaces these rows.
        for (const it of queue.items) {
            if (it.status !== 'failed') continue
            RecordDownload({
                ...EntryFromTags(it.tags, it.hls ? 'footage' : kind, it.baseName, (it.category || []).join('/')),
                status: 'failed',
                error: it.error || 'download failed',
                retry: it.hls
                    ? {
                          type: 'hls',
                          url: it.URL,
                          baseName: it.baseName,
                          tags: it.tags,
                          category: it.category,
                          target: GetSetting('defaultFootageResolution') || '1080p'
                      }
                    : {
                          type: 'audio',
                          url: it.URL,
                          baseName: it.baseName,
                          tags: it.tags,
                          category: it.category,
                          kind
                      }
            })
        }

        const c = queue.counts
        if (c.failed > 0) overlay.showRetryBtn()

        if (queue._cancelled) {
            overlay.done(`Cancelled (${c.done} saved)`)
            return
        }

        if (folderMode) {
            // Detect the common subfolder: if ALL items share the same category
            // (always true for packs, never true for mixed-genre downloads).
            const firstCat = items[0] && items[0].category
            const commonCat = (firstCat && firstCat.length &&
                items.every(it => JSON.stringify(it.category) === JSON.stringify(firstCat)))
                ? firstCat : []
            const toastPath = rootHandle.name + (commonCat.length ? '/' + commonCat.join('/') : '')
            overlay.done(`Saved ${c.done} files to ${toastPath}/`)
            Notify(`Saved ${c.done} files to "${toastPath}"`, 'Artlist DL')
            ShowSavedToast(toastPath, rootHandle, commonCat, kind)
            return
        }

        overlay.update('Creating zip…')
        zipClosed = true
        const zipBlob = await zip.generateAsync({ type: 'blob' }, meta =>
            overlay.update(`Zipping ${Math.round(meta.percent)}%`)
        )
        const saved = await SaveBlob(zipBlob, zipName, [
            { description: 'ZIP File', accept: { 'application/zip': ['.zip'] } }
        ])
        if (saved) {
            for (const row of zipOkRows) RecordDownload(row)
            overlay.done(`Saved ${c.done} files${c.failed ? ', ' + c.failed + ' failed' : ''}`)
            Notify(`Saved ${c.done} files as ${zipName}`, 'Artlist DL')
            ShowSavedToast(zipName, null, [])
        } else {
            overlay.done('Cancelled')
        }
    } catch (e) {
        RecordError('DownloadMany', e, { zipName, count: items.length })
        overlay.fail('Bulk download failed — see ArtlistDL.errors')
        Notify('Bulk download failed', 'Artlist DL')
    }
}

// ---- Scroll page to bottom to trigger lazy-loaded rows ---------------------
async function ScrollToBottom() {
    const scrollEl = unsafeWindow.document.scrollingElement || unsafeWindow.document.documentElement
    const maxWait = 12000 // give up after 12s total
    const started = Date.now()
    let lastHeight = 0
    let stableCount = 0
    while (Date.now() - started < maxWait) {
        const current = scrollEl.scrollHeight
        unsafeWindow.scrollTo(0, scrollEl.scrollHeight)
        await new Promise(r => setTimeout(r, 350))
        // also trigger a LoadServerListAssets pass so data is fetched in parallel
        try {
            const pt = GetPagetype()
            if (pt === MUSIC_ALBUM_PAGETYPE || pt === SFXP_PAGETYPE) {
                await LoadServerListAssets(pt)
            }
        } catch (e) {}
        if (scrollEl.scrollHeight === lastHeight) {
            stableCount++
            if (stableCount >= 3) break // three stable ticks → fully loaded
        } else {
            stableCount = 0
        }
        lastHeight = scrollEl.scrollHeight
    }
    // scroll back to top so the user's view is not left at the bottom
    unsafeWindow.scrollTo(0, 0)
    // small extra delay for React to re-render newly visible rows
    await new Promise(r => setTimeout(r, 300))
}

// ---- "Download all on page" button ----------------------------------------
function CollectPageDownloads() {
    const items = []
    const seen = new Set()
    const pagetype = GetPagetype()
    const skipDl = GetSetting('skipDownloadedInBulk')
    const root = TBody || unsafeWindow.document

    // Footage pages: collect HLS items from loaded footage data. Each item carries
    // the HLS master URL + hls flag; DownloadMany picks the variant per resolution.
    if (IsFootagePagetype(pagetype)) {
        // STORY/pack page: the whole pack arrives at once (data.story.clips), so
        // grab EVERY clip belonging to this story (no cap), foldered under the pack
        // name. Other footage pages stay capped (browse grids can be 1000+ items).
        const isStory = pagetype === FOOTAGE_STORY_PAGETYPE
        const storyId = isStory ? ClipIdFromUrl() : null
        const packFolder = isStory ? [SanitizeFolderName(GetFootageClipTitle())] : null
        const cap = isStory ? 100000 : Clamp(GetSetting('downloadAllCap') || 25, 1, 100000)
        const allClips = LoadedFootageLists.flat()
        for (const clip of allClips) {
            if (items.length >= cap) break
            try {
                const norm = NormalizeClipData(clip)
                if (!norm || !norm.hlsUrl || seen.has(norm.hlsUrl)) continue
                // On a story page, only this pack's clips (filter by storyId)
                if (isStory && storyId && String(norm.storyId) !== String(storyId)) continue
                seen.add(norm.hlsUrl)
                const fid = norm.clipId ? 'f.' + norm.clipId : null
                if (skipDl && fid && IsDownloaded(fid)) continue
                const tags = BuildFootageTags(norm)
                items.push({
                    URL: norm.hlsUrl,
                    hls: true,
                    baseName: MakeFootageFilename(norm, GetSetting('defaultFootageResolution') || ''),
                    tags: tags,
                    category: isStory ? packFolder : GetCategory(norm, null)
                })
            } catch (e) {
                RecordError('CollectPageDownloads.footage', e)
            }
        }
        return items
    }

    const rows = root.querySelectorAll(
        '[data-testid=AudioRow], [data-testid=AlbumRow], [data-testid=SongVariantsWrapper]'
    )
    for (const AudioRow of rows) {
        try {
            const RowData = GetAudioRowData(AudioRow, pagetype)
            if (!RowData) continue
            const AudioData = GetAudioDataFromRowData(RowData)
            if (!AudioData) continue
            const url = AudioData.sitePlayableFilePath || AudioData.playableFileUrl
            if (!url || seen.has(url)) continue
            seen.add(url)
            const tags = BuildTags(AudioData, items.length + 1)
            if (skipDl && tags && tags.id && IsDownloaded(tags.id)) continue
            items.push({
                URL: url,
                baseName: MakeFilename(AudioData, RowData.Pagetype),
                tags: tags,
                category: CategoryForRow(AudioData, AudioRow, pagetype)
            })
        } catch (e) {
            RecordError('CollectPageDownloads', e)
        }
    }
    return items
}

function CountPageRows() {
    const root = TBody || unsafeWindow.document
    return root.querySelectorAll(
        '[data-testid=AudioRow], [data-testid=AlbumRow], [data-testid=SongVariantsWrapper]'
    ).length
}

// The raw row count double-counts (hidden/duplicate rows), so the button shows
// the real number of UNIQUE downloadable tracks — what actually gets saved.
// Recomputed only when the page rows or captured data change (cheap otherwise).
let _dlCountRaw = -1
let _dlCountLoaded = -1
let _dlCountUnique = 0
function LoadedItemsTotal() {
    let total = 0
    for (const group of [
        LoadedMusicLists,
        LoadedSfxLists,
        LoadedSfxsList,
        LoadedSongsList,
        LoadedFootageLists
    ]) {
        for (const lst of group) total += lst ? lst.length : 0
    }
    total += LoadedSstemsLists.length
    return total
}
function GetUniqueDownloadCount() {
    const raw = CountPageRows()
    const loaded = LoadedItemsTotal()
    if (raw !== _dlCountRaw || loaded !== _dlCountLoaded) {
        _dlCountRaw = raw
        _dlCountLoaded = loaded
        try {
            _dlCountUnique = CollectPageDownloads().length
        } catch (e) {
            _dlCountUnique = raw
        }
    }
    return _dlCountUnique
}

// Single song / SFX-track pages render data via server RSC, which the hooks can
// miss on a hard refresh. Fetch the asset straight from the GraphQL API using
// the numeric id in the URL so the banner button always resolves, regardless of
// RSC capture. Stored in SinglePageAsset and used directly (no fuzzy matching).
let SinglePageAsset = null
async function LoadSinglePageAsset(Pagetype) {
    SinglePageAsset = null
    try {
        const segs = unsafeWindow.location.pathname.split('/').filter(Boolean)
        const idStr = segs[segs.length - 1]
        if (!idStr || !/^\d+$/.test(idStr)) return
        let data = null
        if (Pagetype === SONGS_PAGETYPE) {
            data = await GetSongInfo(idStr)
        } else if (Pagetype === SFXS_PAGETYPE) {
            data = await GetSfxInfo(parseInt(idStr, 10))
        }
        if (data) {
            SinglePageAsset = data
            // also feed the matcher (LoadedSfxsList is scanned first for these)
            LoadedSfxsList.push([data])
            LogDebug('injected single-page asset', data)
        }
    } catch (e) {
        RecordError('LoadSinglePageAsset', e)
    }
}

// SFX-pack AND music-album pages render their track list server-side, so we
// reconstruct the metadata via the working sfxs(ids:) / songs(ids:) queries.
// The canonical ids come from each row's track LINK in the DOM (reliable across
// packs/albums); the wavesurfer request filenames are an SFX-only fallback
// (their embedded ids are NOT consistent between packs). Runs repeatedly
// because rows + their requests load lazily as you scroll.
let PackFetchedIds = new Set()
let PackFetchInFlight = false
let PackFetchAttempts = 0
let ModalSongById = new Map() // songId -> song data, for "similar songs" modals
function ResetPackState() {
    PackFetchedIds = new Set()
    PackFetchInFlight = false
    PackFetchAttempts = 0
    ModalSongById = new Map()
}
function CollectServerRowIds(pagetype) {
    const domIds = new Set()
    const waveIds = new Set()
    try {
        const root = TBody || unsafeWindow.document
        for (const a of root.querySelectorAll('a[data-testid=Link]')) {
            const href = a.getAttribute('href') || ''
            if (pagetype === MUSIC_ALBUM_PAGETYPE) {
                // music rows link to /royalty-free-music/song/<slug>/<songId>
                const m = href.match(/\/royalty-free-music\/song\/[^/]+\/(\d+)/)
                if (m) domIds.add(m[1])
            } else {
                if (href.indexOf('/sfx/') === -1) continue
                const m = href.match(/\/(\d{3,})(?:[/?#]|$)/)
                if (m) domIds.add(parseInt(m[1], 10))
            }
        }
    } catch (e) {}
    if (pagetype !== MUSIC_ALBUM_PAGETYPE) {
        // music wavesurfer filenames use UUIDs, so this fallback is SFX-only
        for (const r of RequestLog) {
            const m = r.url.match(/\/wavesurfer\/(\d+)_(\d+)_(\d+)_/)
            if (m) {
                waveIds.add(parseInt(m[1], 10))
                waveIds.add(parseInt(m[2], 10))
                waveIds.add(parseInt(m[3], 10))
            }
        }
    }
    return { domIds: [...domIds], waveIds: [...waveIds] }
}
async function LoadServerListAssets(pagetype) {
    if (PackFetchInFlight) return
    const isMusic = pagetype === MUSIC_ALBUM_PAGETYPE
    const { domIds, waveIds } = CollectServerRowIds(pagetype)
    const all = [...new Set([...domIds, ...waveIds])]
    const newIds = all.filter(id => !PackFetchedIds.has(String(id)))
    if (!newIds.length) return
    PackFetchInFlight = true
    PackFetchAttempts++
    try {
        const items = isMusic
            ? await GetSongsBatch(newIds)
            : await GetSfxsBatch(newIds)
        // always record what we tried vs. what came back, so empties are visible
        Capture(
            'pack-fetch',
            `pt=${pagetype} dom=${domIds.length} wave=${waveIds.length} new=${newIds.length} got=${items.length}`,
            JSON.stringify({
                sampleDomIds: domIds.slice(0, 12),
                sampleWaveIds: waveIds.slice(0, 12),
                got: items.slice(0, 6).map(s => ({
                    id: s.songId,
                    name: s.songName,
                    hasUrl: !!s.sitePlayableFilePath
                }))
            })
        )
        if (items.length) {
            if (isMusic) LoadedMusicLists.push(items)
            else LoadedSfxsList.push(items)
            for (const s of items)
                if (s.songId != null) PackFetchedIds.add(String(s.songId))
            for (const id of newIds) PackFetchedIds.add(String(id)) // stop re-querying
            LogDebug('server list assets loaded:', items.length)
        } else if (PackFetchAttempts >= 4) {
            for (const id of newIds) PackFetchedIds.add(String(id)) // give up
        }
    } catch (e) {
        RecordError('LoadServerListAssets', e)
    } finally {
        PackFetchInFlight = false
    }
}

// "Similar songs" opens a React modal whose rows aren't in the page table and
// aren't covered by any list fetch. Each row links to /song/<slug>/<id>, so we
// fetch those songs by id and key them by id (the scan loop then wires each
// row directly — no fuzzy name matching needed).
async function LoadModalAssets() {
    if (PackFetchInFlight) return
    const ids = new Set()
    try {
        for (const modal of unsafeWindow.document.querySelectorAll(
            '.ReactModal__Content'
        )) {
            for (const a of modal.querySelectorAll('a[data-testid=Link]')) {
                const href = a.getAttribute('href') || ''
                const m = href.match(/\/royalty-free-music\/song\/[^/]+\/(\d+)/)
                if (m && !ModalSongById.has(m[1])) ids.add(m[1])
            }
        }
    } catch (e) {}
    const newIds = [...ids].filter(id => !PackFetchedIds.has('m' + id))
    if (!newIds.length) return
    PackFetchInFlight = true
    try {
        const songs = await GetSongsBatch(newIds)
        Capture(
            'modal-fetch',
            `ids=${newIds.length} got=${songs.length}`,
            JSON.stringify({
                sampleIds: newIds.slice(0, 10),
                got: songs.slice(0, 6).map(s => ({ id: s.songId, name: s.songName }))
            })
        )
        for (const s of songs) {
            if (s.songId != null) ModalSongById.set(String(s.songId), s)
        }
        for (const id of newIds) PackFetchedIds.add('m' + id) // don't re-query
    } catch (e) {
        RecordError('LoadModalAssets', e)
    } finally {
        PackFetchInFlight = false
    }
}

// Wire the download buttons inside "similar songs" modals. The modal rows have
// no predictable testid, so for each download button we climb up to the nearest
// ancestor that contains a /song/<id> link (that's the button's own row), then
// wire it to the song we fetched in LoadModalAssets.
function ProcessModalRows() {
    for (const modal of unsafeWindow.document.querySelectorAll(
        '.ReactModal__Content'
    )) {
        for (const button of modal.querySelectorAll(
            "button[aria-label='download' i]"
        )) {
            try {
                if (button.hasAttribute('artlist-dl-processed')) continue
                // climb up to the first ancestor that holds exactly this row's
                // song link + this one download button (so we don't pair a
                // button with another row's link in a flat layout)
                let el = button
                let link = null
                for (let i = 0; i < 8 && el; i++) {
                    const l =
                        el.querySelector &&
                        el.querySelector(
                            'a[data-testid=Link][href*="/royalty-free-music/song/"]'
                        )
                    if (l) {
                        const btnCount = el.querySelectorAll(
                            "button[aria-label='download' i]"
                        ).length
                        if (btnCount === 1) link = l
                        break
                    }
                    el = el.parentElement
                }
                if (!link) continue
                const m = (link.getAttribute('href') || '').match(
                    /\/song\/[^/]+\/(\d+)/
                )
                if (!m) continue
                const songData = ModalSongById.get(m[1])
                if (!songData) continue // not fetched yet — try again next tick
                WriteAudio(
                    {
                        Pagetype: SONGS_PAGETYPE,
                        Button: button,
                        Element: el,
                        AudioTitle: songData.songName,
                        RawTitle: songData.songName,
                        Artists: []
                    },
                    songData
                )
            } catch (e) {
                RecordError('ProcessModalRows', e)
            }
        }
    }
}

function EnsureDownloadAllButton() {
    const id = 'artlist-dl-all'
    let btn = unsafeWindow.document.getElementById(id)
    if (!GetSetting('showDownloadAll')) {
        if (btn) btn.remove()
        return
    }
    if (!document.body) return

    if (!btn) {
        btn = document.createElement('button')
        btn.id = id
        // sits above Artlist's bottom player bar so it isn't hidden
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '166px', // stacked above the settings gear (which sits at 110px)
            right: '20px',
            zIndex: '2147483646',
            background: '#82ff59',
            color: '#000',
            font: "600 13px 'Poppins', system-ui, sans-serif",
            padding: '10px 14px',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0,0,0,.4)'
        })
        btn.addEventListener('click', async () => {
            StartHelperOnClick() // before the first await, while the click still counts
            try {
                btn.disabled = true
                btn.style.opacity = '0.6'
                const pagetype = GetPagetype()
                const kind = KindForPagetype(pagetype)

                // Footage: do NOT auto-scroll (it would load the entire 1000+ grid).
                // Only the clips already loaded are collected, then hard-capped below.
                if (GetSetting('scrollBeforeDownloadAll') && !IsFootagePagetype(pagetype)) {
                    btn.textContent = '⬇ Scrolling…'
                    await ScrollToBottom()
                }

                const items = CollectPageDownloads()
                btn.disabled = false
                btn.style.opacity = ''
                if (!items.length) {
                    Notify('No downloadable tracks found here', 'Artlist DL')
                    return
                }
                const cap = Clamp(GetSetting('downloadAllCap') || 25, 1, 100000)
                if (
                    items.length > cap &&
                    !unsafeWindow.confirm(
                        `Artlist DL: download all ${items.length} tracks on this page?`
                    )
                ) {
                    return
                }
                const stamp = new Date().toISOString().slice(0, 10)
                const zipName =
                    pagetype === SFXP_PAGETYPE && GetPackTitle()
                        ? SanitizeFilename(GetPackTitle()) + '.zip'
                        : SanitizeFilename(`Artlist ${pagetype} ${stamp}`) + '.zip'
                DownloadMany(items, zipName, kind)
            } catch (e) {
                btn.disabled = false
                btn.style.opacity = ''
                RecordError('DownloadAllButton.click', e)
            }
        })
        document.body.appendChild(btn)
    }

    // keep the live count (and target folder, if set) fresh
    const n = GetUniqueDownloadCount()
    const handle = GetOutputHandle(KindForPagetype(GetPagetype()))
    btn.textContent = handle
        ? `⬇ Download all (${n}) → ${handle.name}`
        : `⬇ Download all (${n})`
}

/* ============================================================================
 * In-page settings UI — a modern, Artlist-styled drawer (Shadow DOM + Poppins)
 * that fronts the existing settings/folder/debug functions. Opened by a floating
 * gear button or the Tampermonkey menu. Adds no new download behaviour.
 * ========================================================================== */

// ---- tiny DOM builder -----------------------------------------------------
function adlEl(tag, props, children) {
    const e = document.createElement(tag)
    if (props) {
        for (const k in props) {
            const v = props[k]
            if (k === 'class') e.className = v
            else if (k === 'text') e.textContent = v
            else if (k === 'html') e.innerHTML = v
            else if (k === 'style') Object.assign(e.style, v)
            else if (k.slice(0, 2) === 'on' && typeof v === 'function')
                e.addEventListener(k.slice(2).toLowerCase(), v)
            else if (v != null) e.setAttribute(k, v)
        }
    }
    if (children) {
        for (const c of [].concat(children)) {
            if (c == null) continue
            e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
        }
    }
    return e
}

const ADL_GEAR_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'

const ADL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.adl-gear, .adl-drawer, .adl-backdrop { font-family: 'Poppins','Segoe UI',system-ui,-apple-system,sans-serif; }

.adl-gear {
  position: fixed; bottom: 110px; right: 20px;
  width: 44px; height: 44px; border-radius: 50%;
  background: #f5d90a; color: #161616; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 16px rgba(0,0,0,.45);
  z-index: 2147483645; transition: transform .25s ease, background .2s ease;
}
.adl-gear:hover { background: #ffe53d; transform: rotate(45deg); }
.adl-gear svg { width: 22px; height: 22px; display: block; }

.adl-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.55);
  opacity: 0; pointer-events: none; transition: opacity .22s ease;
  z-index: 2147483646;
}
:host(.adl-open) .adl-backdrop { opacity: 1; pointer-events: auto; }

.adl-drawer {
  position: fixed; top: 0; right: 0; height: 100%;
  width: 384px; max-width: 92vw;
  background: #121212; color: #f4f4f5;
  display: flex; flex-direction: column;
  transform: translateX(105%); transition: transform .26s cubic-bezier(.4,0,.2,1);
  z-index: 2147483647; box-shadow: -10px 0 40px rgba(0,0,0,.5);
  border-left: 1px solid #262626;
}
:host(.adl-open) .adl-drawer { transform: translateX(0); }

.adl-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid #242424; flex:0 0 auto; }
.adl-brand { display:flex; align-items:center; gap:10px; }
.adl-brand-dot { width:10px; height:10px; border-radius:50%; background:#f5d90a; box-shadow:0 0 10px #f5d90a; }
.adl-brand-name { font-weight:600; font-size:16px; letter-spacing:.2px; }
.adl-ver { font-size:11px; color:#9a9a9a; background:#1f1f1f; padding:2px 8px; border-radius:999px; }
.adl-close { background:transparent; border:none; color:#9a9a9a; font-size:15px; cursor:pointer; width:30px; height:30px; border-radius:8px; }
.adl-close:hover { background:#1f1f1f; color:#fff; }

.adl-body { flex:1 1 auto; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:14px; }
.adl-body::-webkit-scrollbar { width:8px; }
.adl-body::-webkit-scrollbar-thumb { background:#2d2d2d; border-radius:8px; }

.adl-card { background:#1a1a1a; border:1px solid #242424; border-radius:14px; padding:14px 16px; }
.adl-card-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1.2px; color:#f5d90a; margin-bottom:12px; }
.adl-card-body { display:flex; flex-direction:column; gap:13px; }
.adl-hint { font-size:12px; color:#8c8c8c; margin:-4px 0 2px; line-height:1.5; }

.adl-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.adl-row-col { flex-direction:column; align-items:stretch; gap:8px; }
.adl-row-btns { gap:10px; }
.adl-label { font-size:13.5px; color:#e8e8e8; }
.adl-val { font-size:13px; font-weight:600; color:#f5d90a; min-width:18px; text-align:right; }

.adl-switch { position:relative; width:40px; height:22px; flex:0 0 auto; }
.adl-switch input { opacity:0; width:0; height:0; position:absolute; }
.adl-slider { position:absolute; inset:0; background:#3a3a3a; border-radius:999px; transition:.2s; cursor:pointer; }
.adl-slider::before { content:''; position:absolute; height:16px; width:16px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
.adl-switch input:checked + .adl-slider { background:#f5d90a; }
.adl-switch input:checked + .adl-slider::before { transform:translateX(18px); background:#161616; }

.adl-range { width:100%; accent-color:#f5d90a; height:4px; cursor:pointer; }

.adl-num, .adl-text { background:#222; border:1px solid #303030; color:#f4f4f5; border-radius:8px; padding:7px 10px; font-size:13px; font-family:inherit; outline:none; }
.adl-num { width:84px; text-align:right; }
.adl-text { width:100%; }
.adl-num:focus, .adl-text:focus { border-color:#f5d90a; }

.adl-chips { display:flex; flex-wrap:wrap; gap:6px; }
.adl-chip { background:#222; border:1px solid #303030; color:#bdbdbd; border-radius:999px; padding:4px 9px; font-size:11px; cursor:pointer; font-family:inherit; }
.adl-chip:hover { border-color:#f5d90a; color:#f5d90a; }

.adl-folder { background:#161616; border:1px solid #242424; border-radius:10px; padding:11px 12px; display:flex; flex-direction:column; gap:9px; }
.adl-folder-head { display:flex; align-items:center; gap:8px; min-width:0; }
.adl-folder-kind { font-size:11px; font-weight:600; color:#161616; background:#f5d90a; padding:2px 8px; border-radius:999px; flex:0 0 auto; }
.adl-folder-name { font-size:13px; color:#e8e8e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.adl-folder-name.adl-unset { color:#6f6f6f; font-style:italic; }
.adl-folder-actions { display:flex; gap:8px; }

.adl-btn { flex:1 1 auto; background:#262626; border:1px solid #313131; color:#eaeaea; border-radius:9px; padding:8px 12px; font-size:12.5px; font-weight:500; cursor:pointer; font-family:inherit; transition:.15s; }
.adl-btn:hover { background:#2f2f2f; }
.adl-btn-accent { background:#f5d90a; border-color:#f5d90a; color:#161616; font-weight:600; }
.adl-btn-accent:hover { background:#ffe53d; }
.adl-btn-danger:hover { background:#3a1f1f; border-color:#5b2b2b; color:#ff8f8f; }

.adl-log { display:flex; flex-direction:column; gap:6px; max-height:250px; overflow-y:auto; }
.adl-log .adl-hint { margin:0; }
.adl-log-row { display:flex; align-items:center; gap:8px; background:#161616; border:1px solid #242424; border-radius:9px; padding:7px 9px; min-width:0; }
.adl-log-dot { flex:0 0 auto; width:16px; text-align:center; font-weight:700; color:#82ff59; }
.adl-log-row.adl-failed { border-color:#4a2a2a; }
.adl-log-row.adl-failed .adl-log-dot { color:#ff6b6b; }
.adl-log-main { flex:1 1 auto; min-width:0; }
.adl-log-title { font-size:12.5px; color:#e8e8e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.adl-log-meta { font-size:10.5px; color:#7c7c7c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.adl-log-row .adl-chip { flex:0 0 auto; }

.adl-footer { flex:0 0 auto; padding:12px 20px; border-top:1px solid #242424; text-align:center; }
.adl-link { color:#8c8c8c; font-size:12px; text-decoration:none; }
.adl-link:hover { color:#f5d90a; }
`

// ---- Poppins font, fetched CSP-safe via GM_xmlhttpRequest -----------------
function adlFetchText(url) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined')
            return reject(new Error('no GM_xmlhttpRequest'))
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            onload: r => resolve(r.responseText || ''),
            onerror: () => reject(new Error('css fetch failed'))
        })
    })
}
function adlFetchFontDataUrl(url) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined')
            return reject(new Error('no GM_xmlhttpRequest'))
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            onload: r => {
                try {
                    const bytes = new Uint8Array(r.response)
                    let bin = ''
                    const chunk = 0x8000
                    for (let i = 0; i < bytes.length; i += chunk) {
                        bin += String.fromCharCode.apply(
                            null,
                            bytes.subarray(i, i + chunk)
                        )
                    }
                    resolve('data:font/woff2;base64,' + btoa(bin))
                } catch (e) {
                    reject(e)
                }
            },
            onerror: () => reject(new Error('font fetch failed'))
        })
    })
}
let _adlFontPromise = null
function GetPoppinsFontCss() {
    if (_adlFontPromise) return _adlFontPromise
    _adlFontPromise = (async () => {
        const cssText = await adlFetchText(
            'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap'
        )
        const re = /\/\*\s*latin\s*\*\/\s*@font-face\s*{([^}]*)}/g
        const faces = []
        let m
        while ((m = re.exec(cssText))) {
            const block = m[1]
            const wM = block.match(/font-weight:\s*(\d+)/)
            const uM = block.match(/url\((https:\/\/[^)]+\.woff2)\)/)
            if (!wM || !uM) continue
            const dataUrl = await adlFetchFontDataUrl(uM[1])
            faces.push(
                `@font-face{font-family:'Poppins';font-style:normal;font-weight:${wM[1]};font-display:swap;src:url(${dataUrl}) format('woff2')}`
            )
        }
        return faces.join('\n')
    })().catch(e => {
        RecordError('GetPoppinsFontCss', e)
        return ''
    })
    return _adlFontPromise
}

// ---- control factories ----------------------------------------------------
function adlSection(title) {
    const body = adlEl('div', { class: 'adl-card-body' })
    const card = adlEl('div', { class: 'adl-card' }, [
        adlEl('div', { class: 'adl-card-title', text: title }),
        body
    ])
    return { card, body }
}
function adlToggle(label, key, onChange) {
    const input = adlEl('input', { type: 'checkbox' })
    input.checked = !!GetSetting(key)
    input.addEventListener('change', () => {
        SetSetting(key, input.checked)
        if (onChange) {
            try {
                onChange(input.checked)
            } catch (e) {
                RecordError('adlToggle.onChange', e)
            }
        }
    })
    return adlEl('div', { class: 'adl-row' }, [
        adlEl('span', { class: 'adl-label', text: label }),
        adlEl('label', { class: 'adl-switch' }, [
            input,
            adlEl('span', { class: 'adl-slider' })
        ])
    ])
}
function adlSlider(label, key, min, max) {
    const val = adlEl('span', { class: 'adl-val', text: String(GetSetting(key)) })
    const input = adlEl('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: '1',
        class: 'adl-range'
    })
    input.value = String(GetSetting(key))
    input.addEventListener('input', () => {
        val.textContent = input.value
        SetSetting(key, parseInt(input.value, 10))
    })
    return adlEl('div', { class: 'adl-row adl-row-col' }, [
        adlEl('div', { class: 'adl-row' }, [
            adlEl('span', { class: 'adl-label', text: label }),
            val
        ]),
        input
    ])
}
function adlNumber(label, key, min, max) {
    const input = adlEl('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        class: 'adl-num'
    })
    input.value = String(GetSetting(key))
    input.addEventListener('change', () => {
        let v = parseInt(input.value, 10)
        if (isNaN(v)) v = GetSetting(key)
        v = Clamp(v, min, max)
        input.value = String(v)
        SetSetting(key, v)
    })
    return adlEl('div', { class: 'adl-row' }, [
        adlEl('span', { class: 'adl-label', text: label }),
        input
    ])
}
function adlPattern() {
    const input = adlEl('input', { type: 'text', class: 'adl-text' })
    input.value = GetSetting('filenamePattern')
    input.addEventListener('change', () =>
        SetSetting('filenamePattern', input.value)
    )
    const chips = adlEl(
        'div',
        { class: 'adl-chips' },
        ['{type}', '{artist}', '{title}', '{album}', '{ids}'].map(tok =>
            adlEl('button', {
                class: 'adl-chip',
                text: tok,
                onClick: () => {
                    const s = input.selectionStart
                    const eN = input.selectionEnd
                    if (s != null && eN != null) {
                        input.value =
                            input.value.slice(0, s) + tok + input.value.slice(eN)
                    } else {
                        input.value += tok
                    }
                    SetSetting('filenamePattern', input.value)
                    input.focus()
                }
            })
        )
    )
    return adlEl('div', { class: 'adl-row adl-row-col' }, [
        adlEl('span', { class: 'adl-label', text: 'Filename pattern' }),
        input,
        chips
    ])
}
function adlFolderRow(kind) {
    const kindLabel = kind === 'music' ? 'Music' : kind === 'sfx' ? 'SFX' : 'Footage'
    const nameEl = adlEl('span', { class: 'adl-folder-name' })
    const refresh = () => {
        const h = GetOutputHandle(kind)
        nameEl.textContent = h ? h.name : 'Not set'
        nameEl.classList.toggle('adl-unset', !h)
    }
    refresh()

    // Path input for "Open folder" quick-launch via GM_openInTab
    const pathKey = 'folderPath.' + kind
    const pathInput = adlEl('input', {
        type: 'text',
        class: 'adl-text',
        style: { fontSize: '11px', marginTop: '6px' }
    })
    pathInput.value = GetSetting(pathKey) || ''
    pathInput.placeholder = 'Paste full path for quick-open  e.g. C:\\Users\\Amir\\Music'
    pathInput.addEventListener('change', () => SetSetting(pathKey, pathInput.value.trim()))
    pathInput.addEventListener('blur',   () => SetSetting(pathKey, pathInput.value.trim()))

    return adlEl('div', { class: 'adl-folder' }, [
        adlEl('div', { class: 'adl-folder-head' }, [
            adlEl('span', { class: 'adl-folder-kind', text: kindLabel }),
            nameEl
        ]),
        adlEl('div', { class: 'adl-folder-actions' }, [
            adlEl('button', {
                class: 'adl-btn adl-btn-accent',
                text: 'Choose…',
                onClick: async () => { await PickOutputFolder(kind); refresh() }
            }),
            adlEl('button', {
                class: 'adl-btn',
                text: 'Clear',
                onClick: async () => { await ClearOutputFolder(kind); refresh() }
            })
        ]),
        pathInput
    ])
}

// ---- History export helpers -----------------------------------------------
function ExportHistoryCSV() {
    // BOM so Excel reads the UTF-8 titles (accents, dashes) correctly.
    const csv = '﻿' + LogToCsv(DownloadLog, DownloadedIds)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'artlist-dl-history.csv'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
}
function ExportHistoryM3U() {
    const lines = ['#EXTM3U', '#EXTENC:UTF-8']
    for (const [id, meta] of DownloadedIds) {
        const m = meta || {}
        lines.push(`#EXTINF:-1,${m.artist || 'Unknown'} - ${m.name || id}`)
        lines.push(`# album: ${m.album || ''} | downloaded: ${m.ts || ''} | id: ${id}`)
        lines.push('')
    }
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'artlist-dl-history.m3u'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

function adlBuildBody(body) {
    body.innerHTML = ''

    const folders = adlSection('Download folders')
    folders.body.appendChild(
        adlEl('p', {
            class: 'adl-hint',
            text:
                'Pick once — tracks save straight there with no Save dialog. ' +
                'Music, SFX and Footage stay in separate roots.'
        })
    )
    folders.body.appendChild(adlFolderRow('music'))
    folders.body.appendChild(adlFolderRow('sfx'))
    folders.body.appendChild(adlFolderRow('footage'))
    folders.body.appendChild(
        adlToggle('Auto-open folder after download', 'autoOpenFolder')
    )
    folders.body.appendChild(
        adlEl('p', {
            class: 'adl-hint',
            text:
                'Paste a full path (e.g. C:\\Users\\You\\Music) in a folder box above and that folder ' +
                'opens by itself after each download. Run setup_autostart.bat once from the script ' +
                'folder and the Python helper starts with Windows, so you get a real Explorer/Finder ' +
                'window. Without it there is a fallback that opens a browser tab at the path instead, ' +
                'which needs chrome://extensions → Tampermonkey → Details → "Allow access to file ' +
                'URLs" turned on. Debug → Check helper tells you which one is in play.'
        })
    )
    body.appendChild(folders.card)

    const dl = adlSection('Downloads')
    dl.body.appendChild(adlSlider('Parallel downloads', 'concurrency', 1, 8))
    dl.body.appendChild(adlNumber('Retry count per track', 'retryCount', 0, 5))
    dl.body.appendChild(adlNumber('Confirm bulk over', 'downloadAllCap', 1, 100000))
    dl.body.appendChild(adlToggle('Auto-detect file extension', 'autoDetectExtension'))
    dl.body.appendChild(adlToggle('Embed ID3 / Vorbis tags', 'embedTags'))
    const coverRow = adlToggle('Embed cover art (slower)', 'embedCoverArt')
    coverRow.style.display = GetSetting('embedTags') ? '' : 'none'
    dl.body.appendChild(coverRow)
    // show/hide cover art toggle with embedTags
    const embedTagsInput = coverRow.previousSibling && coverRow.previousSibling.querySelector && coverRow.previousSibling.querySelector('input')
    try {
        const tagsToggleInput = dl.body.querySelectorAll('input[type=checkbox]')
        if (tagsToggleInput[2]) {
            tagsToggleInput[2].addEventListener('change', () => {
                coverRow.style.display = tagsToggleInput[2].checked ? '' : 'none'
            })
        }
    } catch (e) {}
    dl.body.appendChild(adlToggle('Auto-scroll to load all rows', 'scrollBeforeDownloadAll'))
    dl.body.appendChild(adlToggle('Per-track progress overlay', 'showPerTrackProgress'))
    body.appendChild(dl.card)

    // ---- Footage card -------------------------------------------------------
    const ftg = adlSection('Footage')
    ftg.body.appendChild(
        adlEl('p', { class: 'adl-hint', text: 'Stock footage download folder and default resolution for bulk downloads.' })
    )
    ftg.body.appendChild(adlFolderRow('footage'))
    ftg.body.appendChild(
        adlEl('div', { class: 'adl-row adl-row-col' }, [
            adlEl('span', { class: 'adl-label', text: 'Default resolution (bulk)' }),
            adlEl('div', { class: 'adl-chips' },
                ['highest', '4K', '1080p', '720p', 'ask'].map(val => {
                    const chip = adlEl('button', {
                        class: 'adl-chip' + (GetSetting('defaultFootageResolution') === val ? ' adl-chip-active' : ''),
                        text: val,
                        style: GetSetting('defaultFootageResolution') === val
                            ? { background: '#5bc8f5', color: '#111', borderColor: '#5bc8f5' } : {}
                    })
                    chip.addEventListener('click', () => {
                        SetSetting('defaultFootageResolution', val)
                        // Update chip styles
                        chip.parentNode.querySelectorAll('button').forEach(b => {
                            const active = b.textContent === val
                            b.style.background = active ? '#5bc8f5' : ''
                            b.style.color = active ? '#111' : ''
                            b.style.borderColor = active ? '#5bc8f5' : ''
                        })
                    })
                    return chip
                })
            )
        ])
    )
    body.appendChild(ftg.card)

    const org = adlSection('Organization')
    const depthRow = adlNumber('Genre folder depth', 'categoryDepth', 1, 5)
    org.body.appendChild(
        adlToggle('Sort into genre folders', 'categorize', on => {
            depthRow.style.display = on ? '' : 'none'
        })
    )
    org.body.appendChild(depthRow)
    depthRow.style.display = GetSetting('categorize') ? '' : 'none'
    org.body.appendChild(adlPattern())
    body.appendChild(org.card)

    const ui = adlSection('Interface')
    ui.body.appendChild(
        adlToggle('Show "Download all" button', 'showDownloadAll', () => {
            try {
                EnsureDownloadAllButton()
            } catch (e) {
                RecordError('toggle.showDownloadAll', e)
            }
        })
    )
    ui.body.appendChild(adlToggle('Desktop notifications', 'notifications'))
    ui.body.appendChild(adlToggle('Mark already-downloaded (yellow)', 'markDownloaded'))
    ui.body.appendChild(adlToggle('Ask before re-downloading (Shift skips)', 'confirmRedownload'))
    ui.body.appendChild(adlToggle('Skip downloaded in "Download all"', 'skipDownloadedInBulk'))
    body.appendChild(ui.card)

    // ---- Local Sync card ----------------------------------------------------
    const sync = adlSection('Local Sync')
    sync.body.appendChild(
        adlEl('p', {
            class: 'adl-hint',
            text: 'Scan your Music/SFX folders and turn existing files\' buttons yellow. Matches by artist + title name (no IDs needed).'
        })
    )

    // Show which folders are currently selected so the user can confirm
    const mkFolderStatusRow = kind => {
        const h = OutputDirHandles[kind]
        return adlEl('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '2px 0' }
        }, [
            adlEl('span', {
                style: {
                    fontSize: '11px', fontWeight: '600', color: '#161616',
                    background: h ? '#f5d90a' : '#555', padding: '2px 8px',
                    borderRadius: '999px', flexShrink: '0'
                },
                text: kind === 'music' ? 'Music' : 'SFX'
            }),
            adlEl('span', {
                style: { fontSize: '12px', color: h ? '#e8e8e8' : '#666', fontStyle: h ? 'normal' : 'italic' },
                text: h ? h.name : 'Not set — pick in Download Folders above'
            })
        ])
    }
    sync.body.appendChild(mkFolderStatusRow('music'))
    sync.body.appendChild(mkFolderStatusRow('sfx'))

    sync.body.appendChild(adlToggle('Auto-sync on startup', 'autoSyncFolders'))

    const syncStatus = adlEl('p', {
        class: 'adl-hint',
        style: { color: '#9a9a9a', marginTop: '2px' },
        text: _lastSyncCount.ts
            ? `Last scan: ${_lastSyncFileCount} files scanned, ${ScannedFiles.size} name keys indexed`
            : 'Not yet scanned this session'
    })
    sync.body.appendChild(syncStatus)

    const scanBtn = adlEl('button', {
        class: 'adl-btn adl-btn-accent',
        text: 'Scan now',
        onClick: async () => {
            if (!OutputDirHandles.music && !OutputDirHandles.sfx) {
                syncStatus.textContent = 'No folder selected — pick one in Download Folders first.'
                syncStatus.style.color = '#f5a623'
                return
            }
            scanBtn.disabled = true
            scanBtn.textContent = 'Scanning…'
            syncStatus.style.color = '#9a9a9a'
            try {
                await SyncAllOutputFolders()
                syncStatus.textContent = `Scan complete — ${_lastSyncFileCount} files scanned, ${ScannedFiles.size} tracks indexed. Browse Artlist to see yellow buttons.`
                Notify(`Local sync: ${_lastSyncFileCount} files scanned`, 'Artlist DL')
            } catch (e) {
                RecordError('manualSync', e)
                syncStatus.textContent = 'Scan failed — see error log'
                syncStatus.style.color = '#ff6666'
            }
            scanBtn.disabled = false
            scanBtn.textContent = 'Scan now'
        }
    })
    sync.body.appendChild(adlEl('div', { class: 'adl-row adl-row-btns' }, [scanBtn]))
    body.appendChild(sync.card)

    // ---- History card -------------------------------------------------------
    const hist = adlSection('History')
    const histCount = adlEl('p', { class: 'adl-hint' })
    const histList = adlEl('div', { class: 'adl-log' })
    const retryAllBtn = adlEl('button', { class: 'adl-btn adl-btn-accent', text: 'Retry failed' })

    const renderHistory = () => {
        const failed = LogFailed(DownloadLog)
        const n = DownloadedIds.size
        histCount.textContent =
            `${n} track${n !== 1 ? 's' : ''} in download history` +
            (failed.length ? ` · ${failed.length} failed` : '')
        retryAllBtn.style.display = failed.length ? '' : 'none'
        retryAllBtn.textContent = `Retry ${failed.length} failed`

        histList.textContent = ''
        const recent = DownloadLog.slice(-15).reverse()
        if (!recent.length) {
            histList.appendChild(adlEl('p', { class: 'adl-hint', text: 'Nothing logged yet — downloads will show up here.' }))
            return
        }
        for (const e of recent) {
            const isFailed = e.status === 'failed'
            const name = e.artist && e.title ? `${e.artist} – ${e.title}` : e.title || e.file || e.id
            const when = new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const row = adlEl('div', { class: 'adl-log-row' + (isFailed ? ' adl-failed' : '') }, [
                adlEl('span', { class: 'adl-log-dot', text: isFailed ? '✕' : '✓' }),
                adlEl('div', { class: 'adl-log-main' }, [
                    adlEl('div', { class: 'adl-log-title', text: name, title: name }),
                    adlEl('div', {
                        class: 'adl-log-meta',
                        text: isFailed ? `${e.kind} · ${when} · ${e.error || 'failed'}` : `${e.kind} · ${when}`,
                        title: [e.folder, e.file].filter(Boolean).join('/')
                    })
                ])
            ])
            if (isFailed && e.retry) {
                const btn = adlEl('button', { class: 'adl-chip', text: 'Retry' })
                btn.addEventListener('click', async () => {
                    btn.disabled = true
                    btn.textContent = '…'
                    try { await RetryLogEntry(e) } catch (err) { RecordError('RetryLogEntry', err) }
                    ReapplyDownloadedStyles()
                    renderHistory()
                })
                row.appendChild(btn)
            }
            histList.appendChild(row)
        }
    }

    // One at a time: parallel retries would race for the folder handle, and this
    // way a run that fails on item 1 still tries item 2.
    //
    // Only rows whose output folder is set. Without one every retry ends in a
    // save dialog, and Chrome only opens that within a few seconds of the click:
    // the first item would work and the rest would fail with a gesture error.
    // Those rows keep their own Retry button, where each click is its own gesture.
    retryAllBtn.addEventListener('click', async () => {
        const failed = LogFailed(DownloadLog).filter(e => e.retry)
        const todo = failed.filter(e => GetOutputHandle(e.kind))
        if (!todo.length) {
            Notify('Set a download folder for these items to retry them together, or use each row\'s Retry button', 'Artlist DL')
            return
        }
        retryAllBtn.disabled = true
        for (const chip of histList.querySelectorAll('.adl-chip')) chip.disabled = true
        let ok = 0
        for (let i = 0; i < todo.length; i++) {
            retryAllBtn.textContent = `Retrying ${i + 1}/${todo.length}…`
            try { if (await RetryLogEntry(todo[i])) ok++ } catch (err) { RecordError('RetryLogEntry', err) }
        }
        retryAllBtn.disabled = false
        ReapplyDownloadedStyles()
        renderHistory()
        const skipped = failed.length - todo.length
        Notify(
            `Retried ${todo.length}: ${ok} saved, ${todo.length - ok} still failing` +
                (skipped ? `, ${skipped} skipped (no download folder set)` : ''),
            'Artlist DL'
        )
    })

    hist.body.appendChild(histCount)
    hist.body.appendChild(histList)
    hist.body.appendChild(adlEl('div', { class: 'adl-row adl-row-btns' }, [retryAllBtn]))
    hist.body.appendChild(
        adlEl('div', { class: 'adl-row adl-row-btns' }, [
            adlEl('button', {
                class: 'adl-btn',
                text: 'Export CSV',
                onClick: () => {
                    try { ExportHistoryCSV() }
                    catch (e) { RecordError('ExportHistoryCSV', e) }
                }
            }),
            adlEl('button', {
                class: 'adl-btn',
                text: 'Export M3U',
                onClick: () => {
                    try { ExportHistoryM3U() }
                    catch (e) { RecordError('ExportHistoryM3U', e) }
                }
            })
        ])
    )
    hist.body.appendChild(
        adlEl('div', { class: 'adl-row adl-row-btns' }, [
            adlEl('button', {
                class: 'adl-btn adl-btn-danger',
                text: 'Clear history',
                onClick: () => {
                    if (!unsafeWindow.confirm('Clear the whole download history and log?\n\nTracks will stop showing as downloaded until they are downloaded or scanned again.')) return
                    DownloadedIds.clear()
                    gmSet(DOWNLOADED_KEY, '[]')
                    DownloadLog = []
                    gmSet(LOG_KEY, '[]')
                    renderHistory()
                    Notify('Cleared downloaded history', 'Artlist DL')
                }
            })
        ])
    )
    renderHistory()
    body.appendChild(hist.card)

    const dbg = adlSection('Debug')
    // Helper status row
    const helperStatus = adlEl('p', {
        class: 'adl-hint',
        style: { color: '#888' },
        text: 'Helper: checking…'
    })
    const setHelperStatus = (text, color) => {
        helperStatus.textContent = text
        helperStatus.style.color = color
    }
    const helperCheck = adlEl('button', {
        class: 'adl-btn',
        text: 'Check helper',
        style: { marginTop: '4px' },
        onClick: async () => {
            setHelperStatus('Checking…', '#888')
            const ok = await CheckHelper()
            HelperAvailable = ok
            setHelperStatus(
                ok ? '✓ Helper is running — "Open folder" opens Explorer directly'
                   : '✗ Helper not running — hit "Start helper"',
                ok ? '#82ff59' : '#f5a623'
            )
        }
    })
    // Launching artlist:// needs user activation, which only exists inside a
    // real click — so RequestHelperStart() runs first, before any await.
    const helperStart = adlEl('button', {
        class: 'adl-btn',
        text: 'Start helper',
        style: { marginTop: '4px' },
        onClick: async () => {
            RequestHelperStart()
            setHelperStatus('Starting…', '#888')
            const ok = await WaitForHelper(6000)
            setHelperStatus(
                ok ? '✓ Helper running'
                   : '✗ Could not start it. Run setup_autostart.bat once in the script folder, then reload this page.',
                ok ? '#82ff59' : '#f5a623'
            )
        }
    })
    // Auto-check on drawer open
    CheckHelper().then(ok => {
        HelperAvailable = ok
        setHelperStatus(
            ok ? '✓ Helper running' : '✗ Helper not running — hit "Start helper"',
            ok ? '#82ff59' : '#f5a623'
        )
    })
    dbg.body.appendChild(helperStatus)
    dbg.body.appendChild(adlEl('div', { class: 'adl-row adl-row-btns' }, [helperCheck, helperStart]))
    dbg.body.appendChild(adlToggle('Verbose debug logging', 'debug'))
    dbg.body.appendChild(
        adlEl('div', { class: 'adl-row adl-row-btns' }, [
            adlEl('button', {
                class: 'adl-btn',
                text: 'Copy debug report',
                onClick: () => {
                    CopyToClipboard(JSON.stringify(BuildDebugReport(), null, 2))
                    Notify('Debug report copied to clipboard', 'Artlist DL')
                }
            }),
            adlEl('button', {
                class: 'adl-btn',
                text: 'Copy error log',
                onClick: () => {
                    CopyToClipboard(JSON.stringify(ErrorLog, null, 2))
                    Notify('Error log copied to clipboard', 'Artlist DL')
                }
            })
        ])
    )
    body.appendChild(dbg.card)
}

// ---- mount / open / close -------------------------------------------------
let ArtlistUI = null
function EnsureSettingsUI() {
    if (ArtlistUI) return ArtlistUI
    if (!document.body) return null
    try {
        const host = adlEl('div', { id: 'artlist-dl-ui' })
        const shadow = host.attachShadow({ mode: 'open' })
        document.body.appendChild(host)

        shadow.appendChild(adlEl('style', { text: ADL_CSS }))
        const fontStyle = adlEl('style')
        shadow.appendChild(fontStyle)

        const gear = adlEl('button', {
            class: 'adl-gear',
            title: 'Artlist DL settings',
            html: ADL_GEAR_SVG,
            onClick: () => OpenSettingsDrawer()
        })
        shadow.appendChild(gear)

        const backdrop = adlEl('div', {
            class: 'adl-backdrop',
            onClick: () => CloseSettingsDrawer()
        })
        shadow.appendChild(backdrop)

        const bodyWrap = adlEl('div', { class: 'adl-body' })
        const drawer = adlEl('aside', { class: 'adl-drawer' }, [
            adlEl('div', { class: 'adl-header' }, [
                adlEl('div', { class: 'adl-brand' }, [
                    adlEl('span', { class: 'adl-brand-dot' }),
                    adlEl('span', { class: 'adl-brand-name', text: 'Artlist DL' }),
                    adlEl('span', { class: 'adl-ver', text: 'v' + ARTLIST_DL_VERSION })
                ]),
                adlEl('button', {
                    class: 'adl-close',
                    text: '✕',
                    onClick: () => CloseSettingsDrawer()
                })
            ]),
            bodyWrap,
            adlEl('div', { class: 'adl-footer' }, [
                adlEl('a', {
                    class: 'adl-link',
                    href: 'https://github.com/xNasuni/artlist-downloader',
                    target: '_blank',
                    text: 'GitHub · report an issue'
                })
            ])
        ])
        shadow.appendChild(drawer)

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && host.classList.contains('adl-open')) {
                CloseSettingsDrawer()
            }
        })

        ArtlistUI = { host, shadow, gear, backdrop, drawer, bodyWrap, fontStyle }
    } catch (e) {
        RecordError('EnsureSettingsUI', e)
        return null
    }
    return ArtlistUI
}
function OpenSettingsDrawer() {
    const ui = EnsureSettingsUI()
    if (!ui) return
    try {
        adlBuildBody(ui.bodyWrap) // rebuild fresh from current settings
        ui.host.classList.add('adl-open')
        if (!ui._fontDone) {
            ui._fontDone = true
            GetPoppinsFontCss().then(css => {
                if (css) ui.fontStyle.textContent = css
            })
        }
    } catch (e) {
        RecordError('OpenSettingsDrawer', e)
    }
}
function CloseSettingsDrawer() {
    if (ArtlistUI) ArtlistUI.host.classList.remove('adl-open')
}

// ---- Tampermonkey menu (collapsed — everything now lives in the UI drawer) -
function RegisterMenu() {
    if (typeof GM_registerMenuCommand === 'undefined') return
    GM_registerMenuCommand('⚙️ Open Artlist DL settings', () => {
        OpenSettingsDrawer()
    })
    // kept as a fallback for when the in-page UI itself can't render
    GM_registerMenuCommand('🐞 Copy debug report to clipboard', () => {
        const report = BuildDebugReport()
        const text = JSON.stringify(report, null, 2)
        CopyToClipboard(text)
        alert(
            `Artlist DL: debug report copied (${text.length} chars, ` +
                `${report.captures.length} captures). Paste it to the developer.`
        )
    })
}

// ---- Debug handle on the page (window.ArtlistDL) --------------------------
try {
    unsafeWindow.ArtlistDL = {
        version: ARTLIST_DL_VERSION,
        get settings() {
            return Object.assign({}, SETTINGS)
        },
        set(key, value) {
            return SetSetting(key, value)
        },
        get errors() {
            return ErrorLog.slice()
        },
        clearErrors() {
            ErrorLog.length = 0
        },
        dumpErrors() {
            const text = JSON.stringify(ErrorLog, null, 2)
            CopyToClipboard(text)
            console.log(text)
            return `${ErrorLog.length} error(s) logged (copied to clipboard)`
        },
        state() {
            return {
                pagetype: GetPagetype(),
                music: LoadedMusicLists,
                sfxLists: LoadedSfxLists,
                sfxs: LoadedSfxsList,
                songs: LoadedSongsList,
                stems: LoadedSstemsLists
            }
        },
        downloaded() {
            return Object.fromEntries(DownloadedIds)
        },
        log() { return DownloadLog },
        exportHistoryCSV() { ExportHistoryCSV() },
        exportHistoryM3U() { ExportHistoryM3U() },
        syncFolders() { return SyncAllOutputFolders() },
        footageSample() {
            const clip = LoadedFootageLists.flat()[0]
            if (!clip) { console.log('[Artlist DL] No footage data captured yet — browse a stock-footage page first'); return null }
            CopyToClipboard(JSON.stringify(clip, null, 2))
            console.log('%c[Artlist DL] footage sample (copied)', 'color:#5bc8f5', clip)
            return clip
        },
        get footageLoaded() { return LoadedFootageLists.flat().length },
        setDebug(v) {
            return SetSetting('debug', !!v)
        },
        get folders() {
            return {
                music: OutputDirHandles.music ? OutputDirHandles.music.name : null,
                sfx: OutputDirHandles.sfx ? OutputDirHandles.sfx.name : null
            }
        },
        pickFolder(kind) {
            return PickOutputFolder(kind || 'music')
        },
        clearFolder(kind) {
            return ClearOutputFolder(kind)
        },
        // returns the first captured track object — paste it back to refine
        // genre detection (see GENRE_FIELDS)
        sampleSong() {
            const groups = [
                LoadedMusicLists,
                LoadedSfxsList,
                LoadedSfxLists,
                LoadedSongsList
            ]
            for (const group of groups) {
                for (const lst of group) {
                    if (lst && lst.length) return lst[0]
                }
            }
            if (LoadedSstemsLists && LoadedSstemsLists.length) {
                return LoadedSstemsLists[0]
            }
            return null
        },
        sampleCategory() {
            const s = this.sampleSong()
            return { sample: s, detectedGenres: s ? GetCategoryFromData(s) : [] }
        },
        // raw response snippets our hooks saw (fetch / xhr / rsc). Run
        // ArtlistDL.captures() on a broken page and paste the result — this
        // shows the actual data shape so the classifier can be fixed.
        captures() {
            CopyToClipboard(JSON.stringify(Captures, null, 2))
            console.log('%c[Artlist DL captures]', 'color:#82ff59', Captures)
            return Captures.map(c => ({
                kind: c.kind,
                url: c.url,
                datatype: c.datatype,
                length: c.length
            }))
        },
        // payloads that arrived but GetDatatype couldn't classify — run
        // ArtlistDL.unprocessed() to see if Artlist changed their schema
        unprocessed() {
            const summary = UnprocessedPayloads.map(p => ({
                time: p.time,
                dataKeys: p.dataKeys
            }))
            CopyToClipboard(JSON.stringify(UnprocessedPayloads, null, 2))
            console.log('%c[Artlist DL unprocessed]', 'color:#82ff59', UnprocessedPayloads)
            return summary
        },
        // Full state dump for debugging a stuck page. Run on the broken page:
        //   await ArtlistDL.diagnose()
        // then paste the result (it's also copied to your clipboard).
        async diagnose() {
            const out = {}
            try {
                out.version = ARTLIST_DL_VERSION
                out.url = unsafeWindow.location.href
                out.host = unsafeWindow.location.host
                out.pathname = unsafeWindow.location.pathname
                out.pagetype = GetPagetype()

                const sp = GetSongPage()
                out.songPageFound = !!sp
                try {
                    const b = sp ? GetBannerData(sp, out.pagetype) : null
                    out.bannerData =
                        b && typeof b === 'object'
                            ? {
                                  audioTitle: b.AudioTitle,
                                  artists: b.Artists,
                                  hasButton: !!b.Button,
                                  pagetype: b.Pagetype
                              }
                            : b
                } catch (e) {
                    out.bannerData = 'GetBannerData threw: ' + e.message
                }

                out.downloadButtonAriaLabels = [
                    ...unsafeWindow.document.querySelectorAll('button[aria-label]')
                ]
                    .map(b => b.getAttribute('aria-label'))
                    .filter(l => l && /download/i.test(l))
                out.h1 = (unsafeWindow.document.querySelector('h1') || {})
                    .textContent
                out.tbody = !!GetTBody() || !!GetTBodyEdgeCase()
                out.rowCount = CountPageRows()
                out.uniqueCount = (() => {
                    try {
                        return CollectPageDownloads().length
                    } catch (e) {
                        return 'threw: ' + e.message
                    }
                })()

                out.loaded = {
                    music: LoadedMusicLists.length,
                    sfxLists: LoadedSfxLists.length,
                    sfxs: LoadedSfxsList.length,
                    songs: LoadedSongsList.length,
                    stems: LoadedSstemsLists.length,
                    total: LoadedItemsTotal()
                }
                out.singlePageAsset = SinglePageAsset
                    ? {
                          songName: SinglePageAsset.songName,
                          artistName: SinglePageAsset.artistName,
                          hasUrl: !!(
                              SinglePageAsset.sitePlayableFilePath ||
                              SinglePageAsset.playableFileUrl
                          )
                      }
                    : null
                out.nextF = unsafeWindow.__next_f
                    ? {
                          isArray: Array.isArray(unsafeWindow.__next_f),
                          length: unsafeWindow.__next_f.length
                      }
                    : 'absent'
                out.folders = {
                    music: OutputDirHandles.music
                        ? OutputDirHandles.music.name
                        : null,
                    sfx: OutputDirHandles.sfx ? OutputDirHandles.sfx.name : null
                }

                // live test of the direct GraphQL fetch used for single pages
                const segs = unsafeWindow.location.pathname
                    .split('/')
                    .filter(Boolean)
                const idStr = segs[segs.length - 1]
                out.urlId = idStr
                try {
                    if (/^\d+$/.test(idStr)) {
                        if (out.pagetype === SONGS_PAGETYPE) {
                            const d = await GetSongInfo(idStr)
                            out.apiFetch = d
                                ? { ok: true, songName: d.songName }
                                : { ok: false, returned: d }
                        } else if (out.pagetype === SFXS_PAGETYPE) {
                            const d = await GetSfxInfo(parseInt(idStr, 10))
                            out.apiFetch = d
                                ? { ok: true, songName: d.songName }
                                : { ok: false, returned: d }
                        } else {
                            out.apiFetch = 'n/a (not a single song/sfx page)'
                        }
                    } else {
                        out.apiFetch = 'no numeric id in url'
                    }
                } catch (e) {
                    out.apiFetch = 'threw: ' + e.message
                }

                out.recentErrors = ErrorLog.slice(-10)
            } catch (e) {
                out.diagnoseError = String((e && e.stack) || e)
            }
            const text = JSON.stringify(out, null, 2)
            CopyToClipboard(text)
            console.log('%c[Artlist DL diagnose]', 'color:#82ff59', out)
            return out
        }
    }
} catch (e) {
    RecordError('expose ArtlistDL', e)
}

RegisterMenu()
LoadOutputFolders().then(() => {
    if (GetSetting('autoSyncFolders')) {
        SyncAllOutputFolders().catch(e => RecordError('autoSync', e))
    }
})
LogDebug('Artlist DL v' + ARTLIST_DL_VERSION + ' loaded')

// ---- Helper auto-lifecycle --------------------------------------------------
// On page load: ping the helper, nothing more. This used to also fire
// artlist://start here to self-heal a missing helper, but a page has no user
// activation at load time, so Chrome's popup blocker ate the call before it
// reached the protocol handler — it never once produced the "Allow artlist.io
// to open Artlist DL Helper?" prompt, it just burned five seconds of polling.
// Starting the helper now belongs to the logon task (setup_autostart.bat), with
// the gesture-driven RequestHelperStart() as the recovery path.
// On tab close: send /disconnect (informational only — the helper no longer
// shuts itself down on this, see artlist_helper.py).
;(async () => {
    const running = await CheckHelper()
    HelperAvailable = running // a false here is re-probed on demand by EnsureHelper()
    if (running) {
        // Tell the helper this tab is open
        GM_xmlhttpRequest({
            method: 'GET', url: HELPER_ORIGIN + '/connect',
            timeout: 1000, onerror: () => {}, ontimeout: () => {}
        })
        LogDebug('Artlist DL Helper connected')
    }
})().catch(() => {})

// When this tab closes, decrement the helper's ref count.
// GM_xmlhttpRequest survives page teardown (runs in extension background).
unsafeWindow.addEventListener('pagehide', () => {
    try {
        GM_xmlhttpRequest({
            method: 'GET', url: HELPER_ORIGIN + '/disconnect',
            timeout: 1500, onerror: () => {}, ontimeout: () => {}
        })
    } catch (e) {}
}, { once: true })

async function ShowSaveFilePickerForURL(url, baseFilename, tags, category, kind) {
    if (!url) {
        RecordError('ShowSaveFilePickerForURL', new Error('no url passed in'), {
            baseFilename
        })
        Notify('Download failed: no URL found', 'Artlist DL')
        return
    }

    // Request folder permission first, while still inside the click gesture.
    const rootHandle = GetOutputHandle(kind)
    let folderReady = false
    if (rootHandle) folderReady = await EnsureFolderPermission(rootHandle)

    try {
        const { blob, contentType } = await FetchBlob(url)
        const ext = GetSetting('autoDetectExtension')
            ? ExtFromContentType(contentType, url)
            : 'aac'
        const data = await MaybeEmbedTags(blob, ext, tags)
        const filename = SanitizeFilename(baseFilename) + '.' + ext

        let savedPath = null
        let savedInFolder = false
        if (folderReady) {
            try {
                const dir = await GetCategoryDir(rootHandle, category)
                await WriteFileToDir(dir, filename, data)
                savedInFolder = true
                savedPath =
                    (category && category.length ? category.join('/') + '/' : '') +
                    filename
            } catch (e) {
                RecordError('writeToFolder', e, { filename })
                // fall through to the Save dialog below
            }
        }

        if (savedPath == null) {
            const mime = data.type || MimeForExt(ext)
            const ok = await SaveBlob(data, filename, [
                { description: 'Audio File', accept: { [mime]: ['.' + ext] } }
            ])
            if (!ok) return // user cancelled the picker
            savedPath = filename
        }

        if (tags && tags.id) MarkDownloaded(tags.id, tags.title, tags.artist, tags.album)
        RecordDownload({
            ...EntryFromTags(tags, kind, filename, savedInFolder ? (category || []).join('/') : ''),
            status: 'ok'
        })
        Notify('Saved: ' + savedPath, 'Artlist DL')
        // "Open folder" toast
        const toastPath = folderReady && rootHandle
            ? rootHandle.name + (category && category.length ? '/' + category.join('/') : '')
            : savedPath
        ShowSavedToast(toastPath, folderReady ? rootHandle : null, category || [], kind)
    } catch (e) {
        RecordError('ShowSaveFilePickerForURL', e, { url, baseFilename })
        RecordDownload({
            ...EntryFromTags(tags, kind, baseFilename, (category || []).join('/')),
            status: 'failed',
            error: e && e.message ? e.message : String(e),
            retry: { type: 'audio', url, baseName: baseFilename, tags, category, kind }
        })
        Notify('Download failed — see console / ArtlistDL.errors', 'Artlist DL')
    }
}

async function ShowSaveFilePickerForURLsZipped(files, filename) {
    // Legacy {URL, Filename} shape is mapped onto the newer DownloadMany helper
    // so the stems path also gets concurrency, progress and error handling.
    return DownloadMany(
        (files || []).map(f => ({
            URL: f.URL,
            baseName: (f.baseName || f.Filename || 'audio').replace(
                /\.[a-z0-9]+$/i,
                ''
            ),
            tags: f.tags
        })),
        filename
    )
}

function Until(testFunc, label) {
    // https://stackoverflow.com/a/52657929
    const startedAt = Date.now()
    let warned = false
    const poll = resolve => {
        if (DontPoll) {
            resolve()
            return
        }
        let ok = false
        try {
            ok = testFunc()
        } catch (e) {
            // a throwing condition must NOT silently stall the await forever
            RecordError('Until' + (label ? ':' + label : ''), e)
        }
        if (ok) {
            resolve()
            return
        }
        // surface long stalls so they're visible in the error log
        if (!warned && Date.now() - startedAt > 8000) {
            warned = true
            RecordError(
                'Until.stall' + (label ? ':' + label : ''),
                new Error('condition still false after 8s')
            )
        }
        setTimeout(_ => poll(resolve), 100)
    }
    return new Promise(poll)
}

function GetPagetype() {
    const PathSplit = unsafeWindow.location.pathname.split('/')
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'royalty-free-music' &&
        (PathSplit[2] === 'song' || PathSplit[2] === 'artist')
    ) {
        return SONGS_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'royalty-free-music' &&
        PathSplit[2] === 'album'
    ) {
        return MUSIC_ALBUM_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'royalty-free-music'
    ) {
        return MUSIC_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'sfx' &&
        PathSplit[2] === 'track'
    ) {
        return SFXS_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'sfx' &&
        PathSplit[2] === 'pack'
    ) {
        return SFXP_PAGETYPE
    }
    if (
        unsafeWindow.location.host == 'artlist.io' &&
        (PathSplit[1] === 'sfx' ||
            (PathSplit[1] === 'sfx' &&
                (PathSplit[2] === 'search' || PathSplit[2] === 'pack')))
    ) {
        return SFX_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'stock-footage' &&
        PathSplit[2] === 'clip'
    ) {
        return FOOTAGE_CLIP_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'stock-footage' &&
        PathSplit[2] === 'story'
    ) {
        return FOOTAGE_STORY_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'stock-footage' &&
        PathSplit[2] === 'collection'
    ) {
        return FOOTAGE_COLLECTION_PAGETYPE
    }
    if (
        unsafeWindow.location.host === 'artlist.io' &&
        PathSplit[1] === 'stock-footage'
    ) {
        return FOOTAGE_PAGETYPE
    }
    return UNKNOWN_DATATYPE
}

function GetDatatype(Data) {
    var Datatype = UNKNOWN_DATATYPE

    try {
        if (
            Data.data.sfxList != undefined &&
            Data.data.sfxList.songs != undefined
        ) {
            Datatype = SFX_PAGETYPE
        }
    } catch (e) {}
    try {
        if (
            Data.data.songList != undefined &&
            Data.data.songList.songs != undefined
        ) {
            Datatype = MUSIC_PAGETYPE
        }
    } catch (e) {}
    try {
        if (
            Data.data.sfxs != undefined &&
            Data.data.sfxs.length === 1 &&
            Data.data.sfxs[0].similarList != undefined
        ) {
            Datatype = SFXS_PAGETYPE
        }
    } catch (e) {}
    try {
        if (Data.data.pack != undefined && Data.data.pack.songs != undefined) {
            Datatype = SFXP_PAGETYPE
        }
    } catch (e) {}
    try {
        if (
            Data.data.sfxs != undefined &&
            Data.data.sfxs.length === 1 &&
            Data.data.sfxs[0].songName != undefined
        ) {
            Datatype = SINGLE_SOUND_EFFECT_DATATYPE
        }
    } catch (e) {}
    try {
        if (
            Data.data.songs != undefined &&
            Data.data.songs.length === 1 &&
            Data.data.songs[0].songName != undefined
        ) {
            Datatype = SINGLE_SONG_DATATYPE
        }
    } catch (e) {}
    try {
        if (
            Data.data.songs != undefined &&
            Data.data.songs.length === 1 &&
            Data.data.songs[0].similarSongs != undefined
        ) {
            Datatype = SONGS_PAGETYPE
        }
    } catch (e) {}

    try {
        if (
            Data.data.songs != undefined &&
            Data.data.songs.length === 1 &&
            Data.data.songs[0].stems != undefined
        ) {
            Datatype = SONG_STEMS_PAGETYPE
        }
    } catch (e) {}
    // Footage list / search page — real shape is clipList.exactResults / .results
    try {
        if (
            (Data.data.clipList && (Data.data.clipList.exactResults || Data.data.clipList.results)) != null ||
            (Data.data.footage && Data.data.footage.clips) != null ||
            (Data.data.stockFootage && Data.data.stockFootage.clips) != null
        ) { Datatype = FOOTAGE_PAGETYPE }
    } catch (e) {}
    // Single footage clip page
    try {
        if (Data.data.clip != null && (Data.data.clip.id || Data.data.clip.clipId) != null) {
            Datatype = FOOTAGE_CLIP_PAGETYPE
        }
    } catch (e) {}
    // Footage STORY / pack page — data.story.clips holds the whole pack at once
    try {
        if (Data.data.story != null && Array.isArray(Data.data.story.clips)) {
            Datatype = FOOTAGE_STORY_PAGETYPE
        }
    } catch (e) {}

    return Datatype
}

function MatchURL(Url) {
    const Pagetype = GetPagetype()
    let URLObject

    try {
        URLObject = new URL(Url)
    } catch (e) {
        return UNKNOWN_DATATYPE
    }

    const hasRsc = URLObject.searchParams.has('_rsc')
    if (hasRsc) {
        return NEXTRSC_DATATYPE
    }

    if (
        Pagetype !== UNKNOWN_DATATYPE &&
        URLObject.host === 'search-api.artlist.io' &&
        (URLObject.pathname === '/v1/graphql' ||
            URLObject.pathname === '/v2/graphql')
    ) {
        return Pagetype
    }

    return UNKNOWN_DATATYPE
}

async function GetSfxInfo(Id) {
    const Query = `query Sfxs($ids: [Int!]!) {
  sfxs(ids: $ids) {
    songId
    songName
    artistId
    artistName
    albumId
    albumName
    assetTypeId
    duration
    sitePlayableFilePath
  }
}
`
    const Variables = {
        ids: [Id]
    }

    const Payload = {
        query: Query,
        variables: Variables
    }

    const Response = await fetch('https://search-api.artlist.io/v1/graphql', {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(Payload)
    })
    const JSONData = await Response.json()

    var Data

    try {
        Data = JSONData.data.sfxs[0]
    } catch (e) {}

    if (Data === undefined) {
        return false
    }

    return Data
}

// Batch lookup of many SFX by id (used to reconstruct pack pages, whose track
// metadata Artlist renders server-side and never sends as a readable request).
async function GetSfxsBatch(ids) {
    const Query = `query Sfxs($ids: [Int!]!) {
  sfxs(ids: $ids) {
    songId
    songName
    artistId
    artistName
    albumId
    albumName
    assetTypeId
    duration
    sitePlayableFilePath
  }
}
`
    try {
        const Response = await fetch(
            'https://search-api.artlist.io/v1/graphql',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: Query, variables: { ids } })
            }
        )
        const JSONData = await Response.json()
        const list = JSONData && JSONData.data && JSONData.data.sfxs
        return Array.isArray(list) ? list.filter(Boolean) : []
    } catch (e) {
        RecordError('GetSfxsBatch', e)
        return []
    }
}

// Batch lookup of many songs by id (used to reconstruct album pages, whose
// track metadata is also server-rendered). songs() takes String ids.
async function GetSongsBatch(ids) {
    const Query = `query Songs($ids: [String!]!) {
  songs(ids: $ids) {
    songId
    songName
    artistId
    artistName
    albumId
    albumName
    assetTypeId
    duration
    sitePlayableFilePath
  }
}
`
    try {
        const Response = await fetch(
            'https://search-api.artlist.io/v1/graphql',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: Query,
                    variables: { ids: ids.map(String) }
                })
            }
        )
        const JSONData = await Response.json()
        const list = JSONData && JSONData.data && JSONData.data.songs
        return Array.isArray(list) ? list.filter(Boolean) : []
    } catch (e) {
        RecordError('GetSongsBatch', e)
        return []
    }
}

async function GetSongInfo(Id) {
    const Query = `query Songs($ids: [String!]!) {
  songs(ids: $ids) {
    songId
    songName
    artistId
    artistName
    albumId
    albumName
    assetTypeId
    duration
    sitePlayableFilePath
  }
}
`
    const Variables = {
        ids: [Id.toString()]
    }

    const Payload = {
        query: Query,
        variables: Variables
    }

    const Response = await fetch('https://search-api.artlist.io/v1/graphql', {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(Payload)
    })
    const JSONData = await Response.json()

    var Data

    try {
        Data = JSONData.data.songs[0]
    } catch (e) {}

    if (Data === undefined) {
        return false
    }

    return Data
}

async function LoadAssetInfo(Id) {
    const Pagetype = GetPagetype()
    if (Pagetype === SFXS_PAGETYPE) {
        SingleSoundEffectData = await GetSfxInfo(Id)
        return true
    }
    if (Pagetype === SONGS_PAGETYPE) {
        SingleSongData = await GetSongInfo(Id)
        return true
    }
    return false
}

function GetAudioTable() {
    return unsafeWindow.document.querySelector(
        'table.w-full.table-fixed[data-testid=AudioTable]'
    )
}

function GetSongPage() {
    return (
        unsafeWindow.document.querySelector('div[data-testid=SongPage]') ||
        unsafeWindow.document.querySelector('div#song-page-react')
    )
}

function GetBanner(SongPage) {
    return SongPage.querySelector('div')
}

function GetActionRow(SongPage) {
    if (window.innerWidth >= 1024) {
        // page layout changes depending on viewport size
        return SongPage.querySelector('div.hidden')
    }
    return SongPage.querySelector('div.block.py-4.px-6')
}

function GetTBody() {
    return (
        unsafeWindow.document.querySelector(
            'div.w-full[data-testid=ComposableAudioList]'
        ) ||
        unsafeWindow.document.querySelector(
            'table[data-testid=AudioTable]>tbody'
        )
    )
}

function GetTBodyEdgeCase() {
    const TBody =
        unsafeWindow.document.querySelector('div[data-testid=Wrapper]') ||
        unsafeWindow.document.querySelector('div[data-testid=ArtistContent]') ||
        unsafeWindow.document.querySelector('div#song-page-tab-panel-1') ||
        unsafeWindow.document.querySelector(
            'div[data-testid=ComposableAudioList]'
        )
    if (TBody === null) {
        return
    }
    if (TBody.parentNode.classList.contains('hidden')) {
        return
    }
    if (
        TBody.querySelector(
            '[data-testid=AudioRow], [data-testid=AlbumRow], [data-testid=SongVariantsWrapper]'
        ) == null
    ) {
        return
    }

    return TBody
}

function GetAudioRowData(AudioRow, Pagetype) {
    var Data = {
        AudioTitle: 'none',
        RawTitle: 'None',
        Artists: [],
        Button: null,
        Pagetype: Pagetype,
        Element: AudioRow
    }
    var AlbumsAndArtists = AudioRow.querySelector(
        'td[data-testid=AlbumsAndArtists]'
    )
    var DataAndActions = AudioRow.querySelector(
        'td[data-testid=DataAndActions]'
    )

    if (Pagetype === SONGS_PAGETYPE) {
        AlbumsAndArtists = AudioRow.querySelector(
            'div[data-testid=AudioDetails]'
        )
        DataAndActions = AudioRow.querySelector(
            'div[data-testid=AnimatedToggleContainer]'
        )
    }

    if (Pagetype == MUSIC_PAGETYPE || Pagetype == MUSIC_ALBUM_PAGETYPE) {
        AlbumsAndArtists = AudioRow.querySelector(
            'div.flex[data-testid=AudioDetails]'
        )
        DataAndActions = AudioRow.querySelector(
            'div[data-testid=AnimatedToggleContainer]'
        )
    }

    if (
        DataAndActions == null &&
        AudioRow.querySelector('span[data-testid=stems-player-stem-name]') &&
        AudioRow.parentNode.getAttribute('data-testid') != 'ComposableAudioList'
    ) {
        // most likely a song stem, so default to audio row
        const StemContainer = AudioRow.parentNode.parentNode
        const Title = StemContainer.querySelector(
            'span[data-testid=stems-player-song-name]'
        )
        const Artists = StemContainer.querySelectorAll(
            'span[data-testid=stems-player-song-artist]'
        )

        Data.Pagetype = SONG_STEMS_PAGETYPE
        Data.AudioTitle = `${AudioRow.querySelector('span[data-testid=stems-player-stem-name]').innerText} of ${Title.innerText}`
        Data.RawTitle = AudioRow.querySelector(
            'span[data-testid=stems-player-stem-name]'
        ).innerText

        for (const Artist of Artists) {
            Data.Artists.push(Artist.innerText)
        }

        DataAndActions = AudioRow
    }

    if (!DataAndActions) {
        LogDebug('DataAndActions not found in', Pagetype, AudioRow)
        return Data
    }

    var Button =
        DataAndActions.querySelector("button[aria-label='download']") ||
        DataAndActions.querySelector("button[aria-label='Download']")

    if (Button) {
        Data.Button = Button
    }

    if (AlbumsAndArtists == null || DataAndActions == null) {
        return Data
    }

    const AudioTitle = AlbumsAndArtists.querySelector(
        'a.truncate[data-testid=Link]'
    )
    const Artists = AlbumsAndArtists.querySelectorAll(
        'a.truncate.text-gray-200[data-testid=Link]'
    )

    if (AudioTitle) {
        Data.AudioTitle = AudioTitle.childNodes[0].textContent.trim()
        Data.RawTitle = Data.AudioTitle
    }
    if (Artists) {
        for (const Artist of Artists) {
            Data.Artists.push(Artist.textContent.replaceAll(',', '').trim())
        }
    }

    if (
        Data.AudioTitle === 'none' &&
        Data.Artists.length === 0 &&
        Data.Button == null
    ) {
        return false
    }
    if (
        (Data.AudioTitle === 'none' || Data.Artists.length === 0) &&
        Data.Button !== null
    ) {
        Data.Button.style.color = ErrorButtonColor
    }

    return Data
}

function GetBannerData(SongPage, Pagetype) {
    const Data = {
        AudioTitle: 'none',
        RawTitle: 'none',
        Artists: [],
        Button: null,
        Pagetype: Pagetype,
        Element: SongPage || null
    }

    if (!SongPage) return false

    const Banner = GetBanner(SongPage)
    const ActionRow = GetActionRow(SongPage)

    // The banner download button uses the distinctive 'direct download' label
    // (track rows use 'download'). Search the whole SongPage so a class change
    // in the action row can't hide it; the banner button is first in DOM order.
    const Button =
        (ActionRow &&
            ActionRow.querySelector("button[aria-label='direct download']")) ||
        SongPage.querySelector("button[aria-label='direct download']") ||
        SongPage.querySelector(
            "button[aria-label='download'], button[aria-label='Download']"
        ) ||
        null

    let Titles = Banner ? Banner.querySelectorAll('h1') : []
    if (!Titles.length) Titles = SongPage.querySelectorAll('h1')
    let Artists = Banner ? Banner.querySelectorAll('a[data-testid=Link]') : []
    if (!Artists.length) Artists = SongPage.querySelectorAll('a[data-testid=Link]')

    if (Titles.length >= 1) {
        Data.AudioTitle = Titles[0].textContent
        Data.RawTitle = Data.AudioTitle
    }
    for (const Artist of Artists) {
        Data.Artists.push(Artist.textContent.replaceAll(',', '').trim())
    }
    Data.Button = Button

    if (Data.AudioTitle === 'none' && Data.Artists.length == 0 && !Data.Button) {
        return false
    }
    return Data
}

function MakeFilename(AssetData, Pagetype) {
    const isMusic =
        Pagetype === MUSIC_PAGETYPE ||
        Pagetype === SONGS_PAGETYPE ||
        Pagetype === SONG_STEMS_PAGETYPE
    const type = isMusic
        ? Pagetype == SONG_STEMS_PAGETYPE
            ? 'Music Stem'
            : 'Music'
        : 'Sfx'
    const NoAlbum = AssetData.albumId === undefined
    const albumPart =
        AssetData.songName != AssetData.albumName
            ? `on ${AssetData.albumName} `
            : ''
    const ids = `${AssetData.artistId}.${NoAlbum ? '' : AssetData.albumId + '.'}${AssetData.songId}`
    const pattern = GetSetting('filenamePattern') || DEFAULT_SETTINGS.filenamePattern
    const name = pattern
        .replace(/\{type\}/g, type)
        .replace(/\{artist\}/g, AssetData.artistName != null ? AssetData.artistName : '')
        .replace(/\{title\}/g, AssetData.songName != null ? AssetData.songName : '')
        .replace(/\{album\}/g, albumPart)
        .replace(/\{ids\}/g, ids)
    return SanitizeFilename(name)
}

// ============================================================================
// Stock Footage support — HLS preview download
//
// Footage clips carry NO direct download URL. The only video link is `clipPath`,
// an HLS master playlist (.m3u8) serving the downscaled PREVIEW stream as MPEG-TS
// segments. We parse the master for quality variants, let the user pick one, fetch
// every .ts segment and concatenate them into a single playable .ts file.
// Full-res source formats (HD / 4K ProRes / 4K MP4) need a paid-subscription
// authenticated endpoint that is not present in the page data.
// Confirmed schema (debug report 2026-06-04): data.clipList.exactResults[] with
// fields: id, clipName, filmMakerDisplayName, filmMakerId, clipPath, width,
// height, duration(ms), availableFormats[], thumbnailUrl.
// ============================================================================

// Normalise a raw footage clip object into a stable canonical shape.
function NormalizeClipData(clip) {
    if (!clip) return null
    return {
        clipId:        clip.id != null ? clip.id : (clip.clipId != null ? clip.clipId : null),
        clipName:      clip.clipName || clip.title || clip.name || '',
        contributor:   clip.filmMakerDisplayName ||
                       (clip.contributor && (clip.contributor.name || clip.contributor)) ||
                       clip.artistName || clip.creatorName || '',
        contributorId: clip.filmMakerId || (clip.contributor && clip.contributor.id) || clip.artistId || null,
        storyId:       clip.storyId != null ? clip.storyId : null,
        storyName:     clip.storyName || '',
        hlsUrl:        clip.clipPath || clip.hlsUrl || clip.previewVideoUrl || '',
        duration:      clip.duration || null, // milliseconds
        width:         clip.width || null,
        height:        clip.height || null,
        availableFormats: Array.isArray(clip.availableFormats) ? clip.availableFormats : [],
        previewUrl:    clip.thumbnailUrl || clip.previewUrl || '',
        coverUrl:      clip.thumbnailUrl || clip.coverUrl || ''
    }
}

function BuildFootageTags(norm) {
    return {
        title:    norm.clipName || '',
        artist:   norm.contributor || '',
        album:    '',
        id:       norm.clipId ? 'f.' + norm.clipId : null,
        coverUrl: norm.previewUrl || ''
    }
}
function MakeFootageFilename(norm, resolutionLabel) {
    const contrib = norm.contributor || 'Unknown'
    // Prefer the live h1 title (exact text) over the reconstructed clipName
    const title = (typeof GetFootageClipTitle === 'function' &&
                   norm.clipId && String(norm.clipId) === String(ClipIdFromUrl())
                   ? GetFootageClipTitle() : '') || norm.clipName || 'Clip'
    // Unique clip id prevents same-title clips (e.g. variants by the same artist,
    // both "Transition, Whip, Urban, Night") from overwriting each other in a
    // shared folder. Deterministic → re-downloading a clip overwrites itself
    // rather than piling up 001/002/003 duplicates.
    const id = norm.clipId ? ' (' + norm.clipId + ')' : ''
    const res = resolutionLabel ? ' [' + resolutionLabel + ']' : ''
    return SanitizeFilename('Footage ' + contrib + ' - ' + title + id + res)
}

// ---- HLS parsing / download ------------------------------------------------
// CSP-safe text fetch (sends Referer so artifacts host doesn't reject hotlinks).
function FetchTextGM(url) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined') {
            fetch(url).then(r => r.text()).then(resolve).catch(reject)
            return
        }
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: { Referer: 'https://artlist.io/' },
            onload: r => resolve(r.responseText || ''),
            onerror: () => reject(new Error('text fetch failed: ' + url))
        })
    })
}
// Parse an HLS master playlist into quality variants.
function ParseHlsMaster(text, baseUrl) {
    const lines = String(text).split('\n')
    const variants = []
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
            const resM = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i)
            const bwM = lines[i].match(/BANDWIDTH=(\d+)/i)
            let uri = (lines[i + 1] || '').trim()
            if (uri && uri[0] !== '#') {
                try { uri = new URL(uri, baseUrl).href } catch (e) {}
                variants.push({
                    width: resM ? parseInt(resM[1], 10) : 0,
                    height: resM ? parseInt(resM[2], 10) : 0,
                    bandwidth: bwM ? parseInt(bwM[1], 10) : 0,
                    url: uri
                })
            }
        }
    }
    return variants
}
// Parse a media playlist into ordered segment URLs.
function ParseHlsSegments(text, baseUrl) {
    const segs = []
    for (const line of String(text).split('\n')) {
        const t = line.trim()
        if (t && t[0] !== '#') {
            let u = t
            try { u = new URL(t, baseUrl).href } catch (e) {}
            segs.push(u)
        }
    }
    return segs
}
// Fetch the master playlist for a clip and return variants (height desc).
// If the URL is already a media playlist (no variants), returns a single entry.
async function GetClipVariants(hlsUrl) {
    const text = await FetchTextGM(hlsUrl)
    let variants = ParseHlsMaster(text, hlsUrl)
    if (!variants.length) {
        variants = [{ width: 0, height: 0, bandwidth: 0, url: hlsUrl }]
    }
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))
    return variants
}
// Choose a variant for a target ('highest'|'4K'|'1080p'|'720p'|'480p'|'ask').
function PickHlsVariant(variants, target) {
    if (!variants || !variants.length) return null
    if (!target || target === 'highest' || target === '4K' || target === 'ask') return variants[0]
    const wantH = parseInt(String(target), 10)
    if (!isNaN(wantH)) {
        // closest variant at or below the requested height, else the smallest
        const atOrBelow = variants.filter(v => v.height && v.height <= wantH)
        if (atOrBelow.length) return atOrBelow[0] // variants are desc, so [0] is the largest ≤ want
        return variants[variants.length - 1]
    }
    return variants[0]
}
// Download every .ts segment of a variant and concatenate into one Blob.
async function DownloadHlsAsBlob(variantUrl, onProgress) {
    const playlist = await FetchTextGM(variantUrl)
    const segUrls = ParseHlsSegments(playlist, variantUrl)
    if (!segUrls.length) throw new Error('no segments in HLS variant playlist')
    const parts = []
    let done = 0
    for (const su of segUrls) {
        const { blob } = await FetchBlob(su)
        parts.push(blob)
        done++
        if (onProgress) onProgress(done, segUrls.length)
    }
    return new Blob(parts, { type: 'video/mp2t' })
}
function VariantLabel(v) {
    if (v.height) return v.height + 'p'
    return 'Preview'
}
// Estimate bytes from bandwidth (bits/s) × duration (ms).
function EstimateVariantBytes(v, durationMs) {
    if (!v.bandwidth || !durationMs) return null
    return Math.round((v.bandwidth / 8) * (durationMs / 1000))
}

// Save a footage Blob to the footage folder (or Save dialog), as .ts.
async function SaveFootageVideo(blob, baseName, tags, category) {
    const ext = 'ts'
    const filename = SanitizeFilename(baseName) + '.' + ext
    const rootHandle = GetOutputHandle('footage')
    let savedPath = null
    if (rootHandle && (await EnsureFolderPermission(rootHandle))) {
        try {
            const dir = await GetCategoryDir(rootHandle, category || [])
            await WriteFileToDir(dir, filename, blob)
            savedPath = (category && category.length ? category.join('/') + '/' : '') + filename
        } catch (e) {
            RecordError('SaveFootageVideo.folder', e, { filename })
        }
    }
    if (savedPath == null) {
        const ok = await SaveBlob(blob, filename, [
            { description: 'Video (MPEG-TS)', accept: { 'video/mp2t': ['.ts'] } }
        ])
        if (!ok) return false
        savedPath = filename
    }
    if (tags && tags.id) MarkDownloaded(tags.id, tags.title, tags.artist, tags.album)
    RecordDownload({
        ...EntryFromTags(tags, 'footage', filename, (category || []).join('/')),
        status: 'ok'
    })
    // "Open folder" toast
    const _toastPath = rootHandle
        ? rootHandle.name + (category && category.length ? '/' + category.join('/') : '')
        : savedPath
    ShowSavedToast(_toastPath, rootHandle || null, category || [], 'footage')
    return savedPath
}

// Core: fetch variants, optionally let the user pick, download + save.
// `forceTarget` (string) skips the picker (used by bulk download).
// `categoryOverride` (array|null) — if provided, use it; otherwise auto-detect.
//   On a footage CLIP page every download (main video + strip clips) goes into
//   footage/<Clip Title>/ so the video and its related SFX are always together.
async function DownloadFootageClip(norm, forceTarget, categoryOverride) {
    if (!norm || !norm.hlsUrl) { Notify('No preview stream for this clip', 'Artlist DL'); return false }
    const Tags = BuildFootageTags(norm)
    // Explicit override wins. Otherwise: clip pages always pack into the h1-titled
    // subfolder; browse/search pages use genre categories from the clip data.
    const Category = (categoryOverride !== undefined && categoryOverride !== null)
        ? categoryOverride
        : (GetPagetype() === FOOTAGE_CLIP_PAGETYPE ? FootagePackFolder() : GetCategory(norm, null))
    let variants
    try {
        variants = await GetClipVariants(norm.hlsUrl)
    } catch (e) {
        RecordError('GetClipVariants', e); Notify('Could not read footage stream', 'Artlist DL'); return false
    }
    if (!variants.length) { Notify('No downloadable stream found', 'Artlist DL'); return false }

    let chosen
    if (forceTarget) {
        chosen = PickHlsVariant(variants, forceTarget)
    } else if (variants.length === 1) {
        chosen = variants[0]
    } else {
        chosen = await ShowResolutionPicker(norm, variants)
        if (!chosen) return false // cancelled
    }

    const overlay = CreateProgressOverlay(null)
    overlay.update('Footage: starting…')
    try {
        const blob = await DownloadHlsAsBlob(chosen.url, (d, t) =>
            overlay.update(`Footage: segment ${d}/${t} (${VariantLabel(chosen)})`)
        )
        overlay.update('Saving…')
        const saved = await SaveFootageVideo(blob, MakeFootageFilename(norm, VariantLabel(chosen)), Tags, Category)
        if (saved) {
            overlay.done('Saved ' + MakeFootageFilename(norm, VariantLabel(chosen)) + '.ts')
            Notify('Saved footage: ' + (norm.clipName || 'clip'), 'Artlist DL')
            return true
        }
        overlay.done('Cancelled')
        return false
    } catch (e) {
        RecordError('DownloadFootageClip', e, { clip: norm.clipId })
        const label = VariantLabel(chosen)
        const baseName = MakeFootageFilename(norm, label)
        RecordDownload({
            ...EntryFromTags(Tags, 'footage', baseName, (Category || []).join('/')),
            status: 'failed',
            error: e && e.message ? e.message : String(e),
            retry: { type: 'hls', url: norm.hlsUrl, baseName, tags: Tags, category: Category, target: label }
        })
        overlay.fail('Footage download failed — see ArtlistDL.errors')
        Notify('Footage download failed', 'Artlist DL')
        return false
    }
}

// ---- Retrying failed log rows -------------------------------------------------
// Both run from a click in the History card, so folder permission and the save
// dialog still have the user activation they need. Success and failure are
// recorded by the save paths themselves; this only reports which one happened.
async function RetryHls(r) {
    try {
        const variants = await GetClipVariants(r.url)
        const variant = PickHlsVariant(variants, r.target || GetSetting('defaultFootageResolution') || '1080p')
        if (!variant) throw new Error('no HLS variant')
        const blob = await DownloadHlsAsBlob(variant.url)
        return !!(await SaveFootageVideo(blob, r.baseName, r.tags, r.category))
    } catch (e) {
        RecordError('RetryHls', e, { url: r.url })
        RecordDownload({
            ...EntryFromTags(r.tags, 'footage', r.baseName, (r.category || []).join('/')),
            status: 'failed',
            error: e && e.message ? e.message : String(e),
            retry: r
        })
        return false
    }
}

// Resolves true when the item is no longer in the failed list afterwards.
async function RetryLogEntry(entry) {
    const r = entry && entry.retry
    if (!r) return false
    if (r.type === 'hls') return RetryHls(r)
    await ShowSaveFilePickerForURL(r.url, r.baseName, r.tags, r.category, r.kind)
    return !LogFailed(DownloadLog).some(e => LogKey(e) === LogKey(entry))
}

// Resolution picker modal (Shadow DOM) — lists HLS variants. Resolves a variant or null.
let _resPickerHost = null
function ShowResolutionPicker(norm, variants) {
    return new Promise(resolve => {
        if (!document.body) { resolve(null); return }
        if (_resPickerHost) _resPickerHost.remove()

        const host = document.createElement('div')
        host.id = 'artlist-dl-respicker'
        const shadow = host.attachShadow({ mode: 'open' })
        document.body.appendChild(host)
        _resPickerHost = host

        const close = () => { host.remove(); _resPickerHost = null; resolve(null) }

        const style = document.createElement('style')
        style.textContent = `
* { box-sizing: border-box; font-family: 'Poppins','Segoe UI',system-ui,sans-serif; }
.backdrop { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:2147483646; display:flex; align-items:center; justify-content:center; }
.modal { background:#121212; border:1px solid #2a2a2a; border-radius:14px; width:380px; max-width:94vw; box-shadow:0 8px 40px rgba(0,0,0,.6); color:#f4f4f5; overflow:hidden; }
.head { display:flex; align-items:center; justify-content:space-between; padding:16px 18px 12px; border-bottom:1px solid #222; }
.title { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:290px; }
.close { background:none; border:none; color:#888; font-size:16px; cursor:pointer; padding:0 4px; }
.close:hover { color:#fff; }
.hint { padding:4px 18px 0; font-size:11px; color:#888; }
.options { padding:12px 18px; display:flex; flex-direction:column; gap:8px; }
.opt { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; border:1px solid #2a2a2a; cursor:pointer; transition:.15s; }
.opt:hover { border-color:#5bc8f5; background:#0e2a33; }
.opt.selected { border-color:#5bc8f5; background:#0e2a33; }
.opt input[type=radio] { accent-color:#5bc8f5; flex:0 0 auto; width:16px; height:16px; cursor:pointer; }
.opt-info { flex:1; min-width:0; }
.opt-label { font-size:13px; font-weight:600; color:#f4f4f5; }
.opt-meta { font-size:11px; color:#888; margin-top:2px; }
.foot { padding:12px 18px 16px; display:flex; gap:10px; justify-content:flex-end; border-top:1px solid #222; }
.btn { padding:9px 18px; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; border:none; }
.btn-cancel { background:#262626; color:#ccc; }
.btn-cancel:hover { background:#333; }
.btn-dl { background:#5bc8f5; color:#111; }
.btn-dl:hover { background:#7dd8ff; }
`
        shadow.appendChild(style)

        const defaultTarget = GetSetting('defaultFootageResolution') || '1080p'
        const defChosen = PickHlsVariant(variants, defaultTarget)
        let selectedIdx = Math.max(0, variants.indexOf(defChosen))

        const backdrop = document.createElement('div')
        backdrop.className = 'backdrop'
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close() })

        const modal = document.createElement('div')
        modal.className = 'modal'
        modal.addEventListener('click', e => e.stopPropagation())

        const head = document.createElement('div')
        head.className = 'head'
        const titleEl = document.createElement('span')
        titleEl.className = 'title'
        titleEl.textContent = 'Download: ' + (norm.clipName || 'Clip')
        const closeBtn = document.createElement('button')
        closeBtn.className = 'close'
        closeBtn.textContent = '✕'
        closeBtn.addEventListener('click', close)
        head.appendChild(titleEl); head.appendChild(closeBtn)
        modal.appendChild(head)

        const hint = document.createElement('div')
        hint.className = 'hint'
        hint.textContent = 'Preview stream (source ' + (norm.width && norm.height ? norm.width + '×' + norm.height : 'HD') + '). Saved as .ts'
        modal.appendChild(hint)

        const optionsWrap = document.createElement('div')
        optionsWrap.className = 'options'

        const radios = []
        variants.forEach((v, i) => {
            const row = document.createElement('label')
            row.className = 'opt' + (i === selectedIdx ? ' selected' : '')
            const radio = document.createElement('input')
            radio.type = 'radio'; radio.name = 'adl-res'; radio.value = String(i)
            radio.checked = i === selectedIdx
            radios.push(radio)
            const info = document.createElement('div')
            info.className = 'opt-info'
            const lbl = document.createElement('div')
            lbl.className = 'opt-label'
            lbl.textContent = v.height ? (v.width + '×' + v.height + ' (' + v.height + 'p)') : 'Preview'
            const meta = document.createElement('div')
            meta.className = 'opt-meta'
            const bytes = EstimateVariantBytes(v, norm.duration)
            meta.textContent = bytes ? '≈ ' + Math.max(1, Math.round(bytes / 1024 / 1024)) + ' MB' : ''
            info.appendChild(lbl); info.appendChild(meta)
            row.appendChild(radio); row.appendChild(info)
            row.addEventListener('click', () => {
                selectedIdx = i
                radios.forEach((r, j) => {
                    r.checked = j === i
                    r.closest('.opt').classList.toggle('selected', j === i)
                })
            })
            optionsWrap.appendChild(row)
        })
        modal.appendChild(optionsWrap)

        const foot = document.createElement('div')
        foot.className = 'foot'
        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'btn btn-cancel'
        cancelBtn.textContent = 'Cancel'
        cancelBtn.addEventListener('click', close)
        const dlBtn = document.createElement('button')
        dlBtn.className = 'btn btn-dl'
        dlBtn.textContent = 'Download'
        dlBtn.addEventListener('click', () => {
            const chosen = variants[selectedIdx]
            host.remove(); _resPickerHost = null
            resolve(chosen || null)
        })
        foot.appendChild(cancelBtn); foot.appendChild(dlBtn)
        modal.appendChild(foot)

        backdrop.appendChild(modal)
        shadow.appendChild(backdrop)

        const keyHandler = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', keyHandler) } }
        document.addEventListener('keydown', keyHandler)
    })
}

// Footage download buttons are rendered ONLY on card hover and React re-creates
// them, so attaching a listener per button is unreliable. Instead we use one
// capture-phase click delegate (works regardless of render timing) plus a tick
// pass that only RE-COLORS visible buttons. Both resolve a button → clip id with
// three strategies so the exact card DOM nesting doesn't matter.

function ClipIdFromHref(href) {
    const m = (href || '').match(/\/stock-footage\/clip\/[^/]+\/(\d+)/)
    return m ? m[1] : null
}
function FindLoadedClipById(id) {
    if (id == null) return null
    for (const c of LoadedFootageLists.flat()) {
        const norm = NormalizeClipData(c)
        if (norm && String(norm.clipId) === String(id)) return norm
    }
    return null
}
// True if a button belongs to an audio row (related SFX/music). On a clip page
// these live in a ComposableAudioList / audio-row-slot that is nested INSIDE the
// same `clip-item` as the footage clip link — so they must never be read as footage.
function IsAudioRowButton(btn) {
    return !!(btn.closest && btn.closest(
        '[data-testid="audio-row-slot"],[data-testid="ComposableAudioList"],[data-testid=AudioRow]'
    ))
}
// Resolve the footage clip id for a download button: climb ancestors for the clip
// link, else (grid hover overlay) the clip link directly beneath the button. Audio
// rows are excluded up front, so the climb can't grab a sibling footage link.
function FindClipIdForButton(btn) {
    if (IsAudioRowButton(btn)) return null
    let el = btn
    for (let i = 0; i < 14 && el; i++) {
        if (el.querySelector) {
            const link = el.querySelector('a[href*="/stock-footage/clip/"]')
            if (link) { const id = ClipIdFromHref(link.getAttribute('href')); if (id) return id }
        }
        el = el.parentElement
    }
    try {
        const r = btn.getBoundingClientRect()
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2
        for (const node of unsafeWindow.document.elementsFromPoint(cx, cy)) {
            const link = node.closest && node.closest('a[href*="/stock-footage/clip/"]')
            if (link) { const id = ClipIdFromHref(link.getAttribute('href')); if (id) return id }
        }
    } catch (e) {}
    return null
}

// The numeric clip id from the current /stock-footage/clip/<slug>/<id> URL.
function ClipIdFromUrl() {
    const segs = unsafeWindow.location.pathname.split('/').filter(Boolean)
    const last = segs[segs.length - 1]
    return /^\d+$/.test(last) ? last : null
}
// Folder for "packing" a clip together: the main clip's video AND its related
// SFX/music all save into footage/<Clip Name>/ so they stay grouped on disk.
// The clip's display title — prefers the live h1 (exact text with commas/punctuation),
// falls back to the URL slug only if the DOM isn't ready yet.
function GetFootageClipTitle() {
    try {
        const h1 = unsafeWindow.document.querySelector('h1')
        const txt = (h1 && h1.textContent.trim()) || ''
        if (txt) return txt
    } catch (e) {}
    try {
        // works for both /clip/<slug>/<id> and /story/<slug>/<id>
        const m = unsafeWindow.location.pathname.match(/\/stock-footage\/(?:clip|story)\/([^/]+)\//)
        if (m) return m[1].replace(/-+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
    } catch (e) {}
    return 'Clip'
}
// Folder for packing a clip + its related SFX together: footage/<Clip Title>/
function FootagePackFolder() {
    const folder = SanitizeFolderName(GetFootageClipTitle())
    return folder ? [folder] : []
}
// Most-recent footage-HLS master playlist we've seen. Hovering / opening a clip
// loads its preview stream, so the LAST one logged is the clip you're interacting
// with. This is how we get a clip's downloadable stream without its metadata
// (Artlist doesn't expose a footage clipList on clip pages).
function MostRecentFootageHls() {
    let last = null
    for (const r of RequestLog) {
        if (/footage-hls\/[^?]*_playlist_[^?]*\.m3u8/.test(r.url)) last = r.url
    }
    return last
}
// Turn a clip slug into a readable name: lost-tension-chase → "Lost Tension Chase".
function ClipNameFromHref(href) {
    try {
        const m = (href || '').match(/\/stock-footage\/clip\/([^/]+)\//)
        if (m) return m[1].replace(/-+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
    } catch (e) {}
    return ''
}
// Resolve a footage clip for a button: prefer real loaded data; otherwise build a
// minimal clip from the most-recent preview HLS + a name from the card/URL/heading.
function ResolveFootageClip(btn, clipId) {
    if (clipId) { const n = FindLoadedClipById(clipId); if (n && n.hlsUrl) return n }
    const id = clipId || ClipIdFromUrl() || '0'
    const hls = MostRecentFootageHls()
    if (!hls) return null
    let name = ''
    if (btn) {
        let el = btn
        for (let i = 0; i < 12 && el; i++) {
            const link = el.querySelector && el.querySelector('a[href*="/stock-footage/clip/"]')
            if (link) { name = ClipNameFromHref(link.getAttribute('href')); break }
            el = el.parentElement
        }
    }
    if (!name) {
        try { const h1 = unsafeWindow.document.querySelector('h1'); if (h1 && h1.textContent.trim()) name = h1.textContent.trim() } catch (e) {}
    }
    if (!name) name = 'Clip'
    let contributor = ''
    try { const a = unsafeWindow.document.querySelector('a[href*="/stock-footage/artist/"]'); if (a && a.textContent.trim()) contributor = a.textContent.trim() } catch (e) {}
    return NormalizeClipData({ id: id, clipName: name, clipPath: hls, filmMakerDisplayName: contributor })
}

// One global capture-phase click delegate — intercepts a footage download click
// before Artlist's own handler (premium upsell) and runs our HLS download.
let _footageDelegationInstalled = false
function InstallFootageDelegation() {
    if (_footageDelegationInstalled) return
    _footageDelegationInstalled = true
    unsafeWindow.document.addEventListener('click', async e => {
        try {
            const pt = GetPagetype()
            if (!IsFootagePagetype(pt)) return
            const t = e.target
            const btn = t && t.closest && t.closest('button')
            if (!btn) return
            const al = (btn.getAttribute('aria-label') || '').toLowerCase()
            if (al.indexOf('download') === -1) return
            // "Related SFX/Music" rows are audio — handled by their own listener.
            if (IsAudioRowButton(btn)) return

            const clipId = FindClipIdForButton(btn)
            const isBanner = pt === FOOTAGE_CLIP_PAGETYPE &&
                (btn.textContent || '').trim().toLowerCase() === 'download'
            // Only handle real footage controls: a strip/grid card (has a clip id)
            // or the labelled main "Download" pill. Everything else (related-SFX
            // icons, music player) is left to its own handler.
            if (!clipId && !isBanner) return

            e.stopImmediatePropagation()
            e.preventDefault()
            StartHelperOnClick()
            const norm = ResolveFootageClip(btn, clipId)
            if (!norm) {
                Notify('Hover the clip to load its preview, then click download', 'Artlist DL')
                return
            }
            if (e.altKey) {
                if (norm.hlsUrl) { CopyToClipboard(norm.hlsUrl); Notify('Copied HLS stream URL', 'Artlist DL') }
                return
            }
            // The MAIN clip (matches the URL id) packs into footage/<Clip Name>/ —
            // the same folder its related SFX use. Strip clips go to the footage root.
            const fid = 'f.' + norm.clipId
            if (!e.shiftKey && !ConfirmRedownload(fid, norm.clipName)) return
            await DownloadFootageClip(norm, null)
            for (const b of unsafeWindow.document.querySelectorAll('[data-artlist-dl-id="' + fid + '"]')) {
                if (IsDownloaded(fid)) ApplyDownloadedStyle(b)
            }
        } catch (err) {
            RecordError('footageDelegation', err)
        }
    }, true)
}

// Tick pass: colour footage download buttons. We colour any card button (resolves
// a clip id) or the main banner — the click delegate downloads via the preview
// HLS, so we don't need the clip's metadata to be loaded first.
function ProcessFootageButtons() {
    const pt = GetPagetype()
    for (const btn of unsafeWindow.document.querySelectorAll("button[aria-label*='download' i]")) {
        if (btn.getAttribute('data-artlist-footage') === '1') continue
        if (IsAudioRowButton(btn)) continue // related SFX/music — not footage
        let id = FindClipIdForButton(btn)
        if (!id && pt === FOOTAGE_CLIP_PAGETYPE &&
            (btn.textContent || '').trim().toLowerCase() === 'download') {
            id = ClipIdFromUrl()
        }
        if (!id) continue
        btn.setAttribute('data-artlist-footage', '1')
        const fid = 'f.' + id
        btn.setAttribute('data-artlist-dl-id', fid)
        btn.style.color = ModifiedFootageButtonColor
        if (IsDownloaded(fid)) ApplyDownloadedStyle(btn)
    }
}

// "Related SFX/Music" on a footage clip page live in audio-row-slot rows inside a
// ComposableAudioList (NOT [data-testid=AudioRow]), so the normal scan loop misses
// them. Wire each row by matching its title against the recommendedSfxs/Songs we
// loaded. They download into the SAME pack folder as the video (footage/<Clip>/).
// Wire the "Related SFX/Music" rows on a footage clip page. These rows have no
// fixed testid across all clip pages (sometimes audio-row-slot, sometimes other),
// so we use a testid-free strategy: find every download button that isn't a
// footage card and isn't the main banner, climb to the nearest audio title link,
// match by title against loaded recommendedSfxs/Songs, then wire as audio.
function ProcessClipPageRelatedButtons() {
    if (!LoadedSfxsList.length && !LoadedMusicLists.length) return
    const pools = LoadedSfxsList.concat(LoadedMusicLists)
    for (const btn of unsafeWindow.document.querySelectorAll('button')) {
        if (btn.hasAttribute('artlist-dl-processed')) continue
        if (btn.getAttribute('data-artlist-footage') === '1') continue
        const al = (btn.getAttribute('aria-label') || '').toLowerCase()
        if (!al.includes('download')) continue
        // Skip the main "Download" pill and footage card buttons
        if ((btn.textContent || '').trim().toLowerCase() === 'download') continue
        if (!IsAudioRowButton(btn) && FindClipIdForButton(btn)) continue // footage card

        // Climb to the smallest ancestor that contains a non-footage audio title
        let rowEl = null, title = ''
        let el = btn
        for (let i = 0; i < 12 && el; i++) {
            if (el.querySelector) {
                // Audio title: a song/sfx link, or any truncate link that isn't a clip link
                const audioLink =
                    el.querySelector('a[href*="/royalty-free-music/song/"]') ||
                    el.querySelector('a[href*="/sfx/track/"]') ||
                    el.querySelector('a[data-testid=Link]:not([href*="/stock-footage/clip/"])') ||
                    el.querySelector('a.truncate:not([href*="/stock-footage/clip/"])')
                if (audioLink && audioLink.textContent.trim()) {
                    title = audioLink.textContent.trim()
                    rowEl = el
                    break
                }
            }
            el = el.parentElement
        }
        if (!rowEl || !title) continue

        const tnorm = NormalizeForMatch(title)
        let matched = null
        for (const lst of pools) {
            for (const d of lst) {
                if (NormalizeForMatch(d.songName || d.name || '') === tnorm) { matched = d; break }
            }
            if (matched) break
        }
        if (!matched) continue

        const artists = []
        for (const a of rowEl.querySelectorAll('a')) {
            const tx = a.textContent.replace(/,/g, '').trim()
            if (tx && NormalizeForMatch(tx) !== tnorm && tx.length < 60) artists.push(tx)
        }
        const RowData = {
            Button: btn, Element: rowEl, Pagetype: FOOTAGE_CLIP_PAGETYPE,
            AudioTitle: title, RawTitle: title, Artists: artists
        }
        try { WriteAudio(RowData, matched) } catch (err) { RecordError('relatedSfxWire', err) }
    }
}

function WriteAudio(RowData, AudioData) {
    const Pagetype = RowData.Pagetype
    // On a footage CLIP page the rows are "Related SFX/Music" (assetTypeId 2 = SFX,
    // 1 = music) — route them by asset type, not by the footage page type.
    const isRelatedMusic = Pagetype === FOOTAGE_CLIP_PAGETYPE && AudioData.assetTypeId === 1
    const ChosenColor =
        Pagetype === MUSIC_ALBUM_PAGETYPE ||
        Pagetype === MUSIC_PAGETYPE ||
        Pagetype === SONGS_PAGETYPE ||
        Pagetype == SONG_STEMS_PAGETYPE ||
        isRelatedMusic
            ? ModifiedMusicButtonColor
            : ModifiedSfxButtonColor
    const FileName = MakeFilename(AudioData, Pagetype)
    const Tags = BuildTags(AudioData)
    // Related SFX/music on a clip page PACK WITH THE VIDEO: same footage folder,
    // same per-clip subfolder. Button stays pink/green so it's clearly audio.
    const isClipRelated = Pagetype === FOOTAGE_CLIP_PAGETYPE
    const Category = isClipRelated
        ? FootagePackFolder()
        : CategoryForRow(AudioData, RowData.Element, Pagetype)
    const Kind = isClipRelated ? 'footage' : KindForPagetype(Pagetype)
    const Url = AudioData.sitePlayableFilePath || AudioData.playableFileUrl
    RowData.Button.setAttribute('artlist-dl-processed', 'true')
    if (Tags && Tags.id) RowData.Button.setAttribute('data-artlist-dl-id', Tags.id)
    const _rowKey = AudioDataKeys(AudioData)[0]
    if (_rowKey) RowData.Button.setAttribute('data-artlist-dl-key', _rowKey)
    RowData.Button.style.color = ChosenColor
    // Mark yellow if: previously downloaded OR file found on disk (ScannedFiles name match)
    const _rowIsLocal = IsInScannedFiles(AudioData)
    if (_rowIsLocal && Tags && Tags.id && !IsDownloaded(Tags.id)) {
        MarkDownloaded(Tags.id, Tags.title, Tags.artist, Tags.album)
    }
    if (IsDownloaded(Tags && Tags.id) || _rowIsLocal) ApplyDownloadedStyle(RowData.Button)
    RowData.Button.addEventListener(
        'click',
        function (event) {
            event.stopImmediatePropagation() // prevent premium popup upsell
            if (event.altKey) {
                event.preventDefault()
                CopyToClipboard(Url)
                Notify('Copied download URL to clipboard', 'Artlist DL')
                return
            }
            StartHelperOnClick()
            if (!event.shiftKey && !ConfirmRedownload(Tags && Tags.id, FileName)) {
                event.preventDefault()
                return
            }
            ShowSaveFilePickerForURL(Url, FileName, Tags, Category, Kind).then(
                () => {
                    if (IsDownloaded(Tags && Tags.id))
                        ApplyDownloadedStyle(RowData.Button)
                }
            )
        },
        true
    )
}

function WriteBanner(BannerData, AudioData) {
    const Pagetype = BannerData.Pagetype
    const ChosenColor =
        Pagetype === MUSIC_PAGETYPE ||
        Pagetype === SONGS_PAGETYPE ||
        Pagetype == SONG_STEMS_PAGETYPE
            ? ModifiedMusicButtonColor
            : ModifiedSfxButtonColor
    const FileName = MakeFilename(AudioData, Pagetype)
    const Tags = BuildTags(AudioData)
    const Category = CategoryForRow(AudioData, BannerData.Element || null, Pagetype)
    const Kind = KindForPagetype(Pagetype)
    const Url = AudioData.sitePlayableFilePath || AudioData.playableFileUrl
    BannerData.Button.setAttribute('artlist-dl-processed', 'true')
    if (Tags && Tags.id) BannerData.Button.setAttribute('data-artlist-dl-id', Tags.id)
    const _bannerKey = AudioDataKeys(AudioData)[0]
    if (_bannerKey) BannerData.Button.setAttribute('data-artlist-dl-key', _bannerKey)
    BannerData.Button.style.color = ChosenColor
    BannerData.Button.style.borderColor = ChosenColor
    const _bannerIsLocal = IsInScannedFiles(AudioData)
    if (_bannerIsLocal && Tags && Tags.id && !IsDownloaded(Tags.id)) {
        MarkDownloaded(Tags.id, Tags.title, Tags.artist, Tags.album)
    }
    if (IsDownloaded(Tags && Tags.id) || _bannerIsLocal) ApplyDownloadedStyle(BannerData.Button)
    BannerData.Button.addEventListener(
        'click',
        function (event) {
            event.stopImmediatePropagation() // prevent premium popup upsell
            if (event.altKey) {
                event.preventDefault()
                CopyToClipboard(Url)
                Notify('Copied download URL to clipboard', 'Artlist DL')
                return
            }
            StartHelperOnClick()
            if (!event.shiftKey && !ConfirmRedownload(Tags && Tags.id, FileName)) {
                event.preventDefault()
                return
            }
            ShowSaveFilePickerForURL(Url, FileName, Tags, Category, Kind).then(
                () => {
                    if (IsDownloaded(Tags && Tags.id))
                        ApplyDownloadedStyle(BannerData.Button)
                }
            )
        },
        true
    )
}

var changeBackTimeout = -1
function WriteDownloadAllStems(StemsContainer, DownloadButton) {
    const Pagetype = GetPagetype()
    const ChosenColor = ModifiedMusicButtonColor
    DownloadButton.setAttribute('artlist-dl-processed', 'true')
    DownloadButton.style.backgroundColor = ChosenColor
    DownloadButton.style.borderColor = ChosenColor
    DownloadButton.style.color = 'black'
    DownloadButton.addEventListener('click', async function (event) {
        event.stopImmediatePropagation() // prevent dropdown
        clearTimeout(changeBackTimeout)
        changeBackTimeout = setTimeout(() => {
            DownloadButton.querySelector('span.whitespace-nowrap').innerText =
                'Download All Stems'
            DownloadButton.disabled = false
        }, 10000)
        DownloadButton.querySelector('span.whitespace-nowrap').innerText =
            'Please Wait...'
        DownloadButton.disabled = true
        const dataList = []
        var firstData = null
        for (const StemDescendant of StemsContainer.querySelectorAll(
            'span[data-testid=stems-player-stem-name]'
        )) {
            const Stem = StemDescendant.parentNode
            try {
                const AudioData = GetAudioDataFromRowData(
                    GetAudioRowData(Stem, SONG_STEMS_PAGETYPE)
                )
                if (!firstData) {
                    firstData = AudioData
                }

                dataList.push({
                    URL:
                        AudioData.sitePlayableFilePath ||
                        AudioData.playableFileUrl,
                    baseName: MakeFilename(AudioData, SONG_STEMS_PAGETYPE),
                    tags: BuildTags(AudioData),
                    category: GetCategory(AudioData, Stem)
                })
            } catch (e) {
                RecordError('WriteDownloadAllStems.stem', e)
            }
        }

        if (!firstData || !dataList.length) {
            RecordError(
                'WriteDownloadAllStems',
                new Error('no stems resolved'),
                { count: dataList.length }
            )
            Notify('No downloadable stems found', 'Artlist DL')
        } else {
            const fileName =
                SanitizeFilename(
                    `Music Stems ${firstData.artistName} - ${firstData._songName}${firstData._songName == firstData._albumName ? '' : ` on ${firstData._albumName}`}`
                ) + '.zip'
            await DownloadMany(dataList, fileName, 'music')
        }
        clearTimeout(changeBackTimeout)
        DownloadButton.querySelector('span.whitespace-nowrap').innerText =
            'Download All Stems'
        DownloadButton.disabled = false
    })
}

function MatchAudioToRow(AudioData, RowData, SkipArtistCheck) {
    const dataName = (AudioData.songName || AudioData.name || '').trim()
    const rowName = (RowData.RawTitle || '').trim()

    let nameMatch = dataName === rowName
    if (!nameMatch && RowData.Pagetype === SFXP_PAGETYPE && dataName && rowName) {
        // pack rows show "Pack Name - Sound" while the data may be just "Sound"
        // (or vice-versa) — match if one is the other with a "… - " prefix
        const r = rowName.toLowerCase()
        const d = dataName.toLowerCase()
        nameMatch =
            r.endsWith(' - ' + d) ||
            d.endsWith(' - ' + r) ||
            (r.endsWith(d) && r.length - d.length <= 80) ||
            (d.endsWith(r) && d.length - r.length <= 80)
    }
    if (!nameMatch) return false

    // packs don't carry a reliable per-track artist match — accept on name
    if (SkipArtistCheck || RowData.Pagetype === SFXP_PAGETYPE) return true

    const artist = (AudioData.artistName || '').trim()
    return RowData.Artists.indexOf(artist) != -1
}

function OnRowAdded(AudioRow, RowData, AudioData) {
    AudioRow.setAttribute('artlist-dl-state', 'modified')
    if (AudioData !== undefined) {
        WriteAudio(RowData, AudioData)
        return true
    }
    // data not captured yet — leave it for a retry (see the scan loop)
    if (RowData.Button !== null) {
        RowData.Button.style.color = ErrorButtonColor
    }
    return false
}

function cloneref(object) {
    return {
        ...object
    }
}

function transformIndexedObject2Array(object) {
    return Object.values(object)
}

function GetAudioDataFromRowData(RowData) {
    if (RowData.Pagetype === SFX_PAGETYPE) {
        for (const SfxList of LoadedSfxLists) {
            for (const SfxData of SfxList) {
                if (MatchAudioToRow(SfxData, RowData)) {
                    return SfxData
                }
            }
        }
        // "Similar SFX" opens an INLINE list under the clicked row (not a modal).
        // Its data arrives as the SFXS datatype → LoadedSfxsList, so the row won't
        // match against LoadedSfxLists above. Scan LoadedSfxsList as a fallback.
        for (const SfxsList of LoadedSfxsList) {
            for (const SfxData of SfxsList) {
                if (MatchAudioToRow(SfxData, RowData)) {
                    return SfxData
                }
            }
        }
    }
    if (
        RowData.Pagetype === MUSIC_PAGETYPE ||
        RowData.Pagetype === MUSIC_ALBUM_PAGETYPE
    ) {
        if (LoadedMusicLists.length <= 0) {
            LogDebug('No loaded songs to loop through.')
            return
        }
        for (const MusicList of LoadedMusicLists) {
            for (const SongData of MusicList) {
                if (MatchAudioToRow(SongData, RowData)) {
                    return SongData
                }
            }
        }
    }
    if (
        RowData.Pagetype === SFXS_PAGETYPE ||
        RowData.Pagetype === SFXP_PAGETYPE ||
        RowData.Pagetype == SONGS_PAGETYPE
    ) {
        if (LoadedSfxsList.length <= 0) {
            LogDebug('No loaded sfxs to loop through.')
            return
        }
        for (const SfxsList of LoadedSfxsList) {
            for (const SfxData of SfxsList) {
                if (MatchAudioToRow(SfxData, RowData)) {
                    return SfxData
                }
            }
        }
    }
    if (RowData.Pagetype === SONGS_PAGETYPE) {
        if (LoadedSongsList.length <= 0) {
            LogDebug('No loaded similar songs to loop through.')
            return
        }
        for (const SongsList of LoadedSongsList) {
            for (const SongData of SongsList) {
                if (MatchAudioToRow(SongData, RowData)) {
                    return SongData
                }
            }
        }
    }
    if (RowData.Pagetype === FOOTAGE_CLIP_PAGETYPE) {
        // "Related SFX/Music" rows on a footage clip page: their data was routed to
        // LoadedSfxsList / LoadedMusicLists from clip.recommendedSfxs/recommendedSongs.
        for (const SfxsList of LoadedSfxsList) {
            for (const SfxData of SfxsList) {
                if (MatchAudioToRow(SfxData, RowData)) return SfxData
            }
        }
        for (const MusicList of LoadedMusicLists) {
            for (const SongData of MusicList) {
                if (MatchAudioToRow(SongData, RowData)) return SongData
            }
        }
    }
    if (RowData.Pagetype === SONG_STEMS_PAGETYPE) {
        if (LoadedSstemsLists.length <= 0) {
            LogDebug('No loaded song stems to loop through.')
            return
        }
        for (const StemData of LoadedSstemsLists) {
            for (const Stem of StemData.stems) {
                if (MatchAudioToRow(Stem, RowData, true)) {
                    const clonedData = cloneref(StemData)
                    clonedData.sitePlayableFilePath = Stem.playableFileUrl
                    clonedData._songName = clonedData.songName
                    clonedData._albumName = clonedData.albumName
                    clonedData.songName = `${Stem.name} of ${StemData.songName}`
                    clonedData.albumName = `${Stem.name} of ${StemData.albumName}`
                    return clonedData
                }
            }
        }
    }

    LogDebug("Couldn't handle data:", RowData)
}

function HandleJSONData(Data) {
    // Footage CLIP pages return data.clip.recommendedSfxs / recommendedSongs — the
    // "Related SFX/Music" lists. They're standard audio objects, so route them into
    // the SFX/music pools (matched on the clip page via the FOOTAGE_CLIP branch in
    // GetAudioDataFromRowData). Runs additively before the datatype branching below.
    try {
        const clip = Data && Data.data && Data.data.clip
        if (clip) {
            if (Array.isArray(clip.recommendedSfxs) && clip.recommendedSfxs.length) {
                LoadedSfxsList.push(clip.recommendedSfxs)
                LogDebug('related SFX loaded:', clip.recommendedSfxs.length)
            }
            const recMusic = clip.recommendedSongs || clip.recommendedMusic
            if (Array.isArray(recMusic) && recMusic.length) {
                LoadedMusicLists.push(recMusic)
                LogDebug('related music loaded:', recMusic.length)
            }
        }
    } catch (e) {}

    const Datatype = GetDatatype(Data)
    if (Datatype === SONGS_PAGETYPE) {
        LoadedSongsList.push(Data.data.songs[0].similarSongs)
        return
    }
    if (Datatype === MUSIC_PAGETYPE) {
        LoadedMusicLists.push(Data.data.songList.songs)
        return
    }
    if (Datatype === SFXS_PAGETYPE) {
        LoadedSfxsList.push(Data.data.sfxs[0].similarList)
        return
    }
    if (Datatype == SFXP_PAGETYPE) {
        LoadedSfxsList.push(Data.data.pack.songs)
        return
    }
    if (Datatype === SFX_PAGETYPE) {
        LoadedSfxLists.push(Data.data.sfxList.songs)
        return
    }
    if (
        Datatype === SONG_STEMS_PAGETYPE &&
        Data.data.songs &&
        Data.data.songs[0] &&
        Data.data.songs[0].stems
    ) {
        LoadedSstemsLists.push(Data.data.songs[0])
        return
    }
    if (Datatype === FOOTAGE_PAGETYPE) {
        const cl = Data.data.clipList || {}
        const clips = [
            ...(cl.exactResults || []),
            ...(cl.results || []),
            ...((Data.data.footage && Data.data.footage.clips) || []),
            ...((Data.data.stockFootage && Data.data.stockFootage.clips) || [])
        ]
        if (clips.length) { LoadedFootageLists.push(clips); LogDebug('footage list loaded:', clips.length) }
        return
    }
    if (Datatype === FOOTAGE_CLIP_PAGETYPE) {
        const clip = Data.data.clip || (Data.data.clips && Data.data.clips[0])
        if (clip) { LoadedFootageLists.push([clip]); LogDebug('footage clip loaded:', clip.id || clip.clipId) }
        return
    }
    if (Datatype === FOOTAGE_STORY_PAGETYPE) {
        const clips = (Data.data.story && Data.data.story.clips) || []
        if (clips.length) { LoadedFootageLists.push(clips); LogDebug('footage story/pack loaded:', clips.length) }
        return
    }

    // capture the shape of unrecognised payloads so we can see if Artlist
    // changed their schema — inspect later with ArtlistDL.unprocessed()
    try {
        const keys = Data && Data.data ? Object.keys(Data.data) : Object.keys(Data || {})
        UnprocessedPayloads.push({ time: new Date().toISOString(), dataKeys: keys, sample: Data })
        if (UnprocessedPayloads.length > 20) UnprocessedPayloads.shift()
        LogDebug('Not processed:', Datatype, keys)
    } catch (e) {}
}

function HandleRSCEntry(DataStr) {
    // capture any RSC chunk that looks like it carries audio data, so we can
    // see the real structure even if parsing/detection below fails
    if (
        typeof DataStr === 'string' &&
        /sitePlayableFilePath|playableFileUrl|audioUrl|audioDetails|"songName"|"audioName"|"sfxs"|"songId"|"audioId"/.test(
            DataStr
        )
    ) {
        Capture('rsc', 'rsc-entry', DataStr)
    }

    var Data = null

    const [_, right] = DataStr.split(/:(.+)/)

    Data = JSON.parse(right)

    var found = null

    for (const k in Data) {
        const v = Data[k]

        if (
            v &&
            typeof v === 'object' &&
            ('artistSongs' in v ||
                'songData' in v ||
                'pack' in v ||
                'album' in v ||
                'clipData' in v ||
                'footageData' in v ||
                'clip' in v ||
                v?.data?.sfxs)
        ) {
            found = v
        }
    }

    if (!found) {
        throw new Error('no audio data found')
    }

    try {
        const datatype = GetDatatype(found)
        if (datatype != UNKNOWN_DATATYPE) {
            HandleJSONData(found)
            return
        }

        if (!!found.album) {
            HandleJSONData({
                data: {
                    songList: {
                        songs: found.album.songs
                    }
                }
            })
        }

        if (!!found.pack) {
            HandleJSONData({
                data: {
                    pack: found.pack
                }
            })
        }

        if (!!found.songData) {
            HandleJSONData({
                data: {
                    sfxs: [
                        {
                            similarList: [found.songData]
                        }
                    ]
                }
            })
        }
        if (!!found.artistSongs) {
            for (var song of found.artistSongs) {
                song.songId = song.audioDetails.audioId
                song.songName = song.audioDetails.audioName
                song.artistName = song.audioDetails.artists[0].name
                song.artistId = song.audioDetails.artists[0].id
                song.sitePlayableFilePath = song.audioUrl
            }
            HandleJSONData({
                data: {
                    sfxList: {
                        page: 1,
                        songs: transformIndexedObject2Array(found.artistSongs),
                        suggestion: []
                    }
                }
            })
        }
        // Footage RSC shapes
        if (found.clipData || found.clip) {
            HandleJSONData({ data: { clip: found.clipData || found.clip } })
        }
        if (found.footageData) {
            HandleJSONData({ data: { footage: found.footageData } })
        }
    } catch (e) {
        console.warn(found)
        console.error(e)
        alert(
            `Artlist Downloader: please report this in https://github.com/xNasuni/artlist-downloader\n#HNRSC>${String(e)}`
        )
        throw e
    }
}

function HookNextRSC() {
    var oldNextFPush = null
    var handler = function () {
        try {
            const Container = arguments[0]
            if (Container[0] != 1) {
                throw new Error('invalid format')
            }

            const DataStr = Container[1]
            HandleRSCEntry(DataStr)
        } catch (e) {}

        return oldNextFPush.apply(this, arguments)
    }

    const processExisting = Container => {
        try {
            if (Container && Container[0] == 1) HandleRSCEntry(Container[1])
        } catch (e) {}
    }

    if (RSCInterval != -1) {
        clearInterval(RSCInterval)
    }
    const installRSC = () => {
        if (!unsafeWindow.__next_f || !unsafeWindow.__next_f.push) {
            return
        }
        if (unsafeWindow.__next_f.push == handler) {
            return
        }

        // On a fresh (refreshed / direct) load, the initial RSC chunks were
        // pushed before we could hook .push — replay them so their audio data
        // is captured. (HandleJSONData de-dups by first match, so this is safe.)
        try {
            for (const entry of unsafeWindow.__next_f) processExisting(entry)
        } catch (e) {
            RecordError('installRSC.replay', e)
        }

        oldNextFPush = unsafeWindow.__next_f.push
        unsafeWindow.__next_f.push = handler
    }
    installRSC() // install immediately so we don't miss early RSC chunks
    RSCInterval = setInterval(installRSC, 250)
}

function HandleListRSC(responseText) {
    const Entries = responseText.split('\n').filter(v => v.trim() !== '')

    for (var Entry of Entries) {
        try {
            HandleRSCEntry(Entry)
        } catch (e) {}
    }
}

function ApplyXHR(XHR, Datatype) {
    if (Datatype !== UNKNOWN_DATATYPE) {
        XHR.addEventListener('readystatechange', function () {
            if (XHR.readyState == XMLHttpRequest.DONE) {
                Capture('xhr', XHR.responseURL || '?', XHR.responseText)
                if (Datatype == NEXTRSC_DATATYPE) {
                    HandleListRSC(XHR.responseText)
                } else {
                    var JSONData
                    try {
                        JSONData = JSON.parse(XHR.responseText)
                    } catch (e) {
                        LogDebug("Couldn't parse XHR as json")
                        return
                    }
                    HandleJSONData(JSONData)
                }
            }
        })
    }
}

function HookRequests() {
    var handler = function () {
        const Method = arguments[0]
        const URL = arguments[1]

        RecordRequest(Method, URL)
        const UrlDatatype = MatchURL(URL)
        if (UrlDatatype != UNKNOWN_DATATYPE) {
            ApplyXHR(this, UrlDatatype)
        } else if (typeof URL === 'string' && /artlist/.test(URL)) {
            // unknown Artlist endpoint — peek for audio data we should capture
            CaptureXHRIfAudio(this, URL)
        }

        return oldXMLHttpRequestOpen.apply(this, arguments)
    }
    var handler_fetch = async function () {
        const reqArg = arguments[0]
        // fetch() can be called with a string URL or a Request object
        const url =
            typeof reqArg === 'string' ? reqArg : reqArg && reqArg.url

        const data = await oldFetch.apply(this, arguments)

        RecordRequest('FETCH', url)
        try {
            const UrlDatatype = MatchURL(url)
            if (UrlDatatype != UNKNOWN_DATATYPE) {
                const text = await data.clone().text()
                Capture('fetch', url, text)
                if (UrlDatatype == NEXTRSC_DATATYPE) {
                    HandleListRSC(text)
                } else {
                    // GraphQL JSON (search-api) — mirror the XHR hook, which
                    // parses JSON and feeds HandleJSONData. Routing this to the
                    // RSC parser (the old behaviour) silently dropped the data.
                    let json = null
                    try {
                        json = JSON.parse(text)
                    } catch (e) {}
                    if (json) HandleJSONData(json)
                    else HandleListRSC(text)
                }
            } else if (typeof url === 'string' && /artlist/.test(url)) {
                // unknown Artlist endpoint — peek for audio data we should capture
                const text = await data.clone().text()
                if (AUDIO_KEYS_RE.test(text)) Capture('fetch-audio', url, text)
            }
        } catch (e) {
            RecordError('handler_fetch', e)
        }

        return data
    }

    if (RequestsInterval != -1) {
        clearInterval(RequestsInterval)
    }
    const installRequests = () => {
        unsafeWindow.XMLHttpRequest.prototype.open = handler
        unsafeWindow.fetch = handler_fetch
    }
    installRequests() // install immediately so early requests are captured
    RequestsInterval = setInterval(installRequests, 250)
}

// this makes the user-script support the [←] Back and [→] Right navigations
// aswell as switching pages because artlist doesn't navigate, but instead
// changes their HTML dynamically so that the end-user does not have to
// reload the entire page.

// by polling the changes in an albeit bad way, we can detect when this
// occurs, and as far as i know there's no other better way to do it.
// please make an issue on github and educate me if there is.

async function Initialize() {
    DontPoll = false

    // clear the previous scan interval so SPA navigations don't stack timers
    if (LastInterval !== -1) {
        clearInterval(LastInterval)
        LastInterval = -1
    }

    const Pagetype = GetPagetype()
    let bannerReapply = null // re-applies the banner button if React re-renders it
    SinglePageAsset = null // reset; only single song/SFX pages repopulate it
    ResetPackState() // fresh per page so navigating between packs can't stall

    if (Pagetype === SONGS_PAGETYPE || Pagetype === SFXS_PAGETYPE) {
        // Fetch this page's track from the API so the banner resolves even when
        // the RSC capture misses on a hard refresh.
        await LoadSinglePageAsset(Pagetype)
        LogDebug('searching for banner...')

        // re-query SongPage each poll — on a fresh load it may not exist yet
        await Until(() => {
            SongPage = GetSongPage()
            if (!SongPage) return false
            const Data = GetBannerData(SongPage, Pagetype)
            return Data != false && Data.Button != null
        }, 'banner')
        const RowData = GetBannerData(SongPage, Pagetype)
        // Prefer the directly-fetched asset; fall back to RSC-matched data.
        await Until(() => {
            return SinglePageAsset != null || GetAudioDataFromRowData(RowData) != null
        }, 'banner-data')
        const AudioData = SinglePageAsset || GetAudioDataFromRowData(RowData)
        if (RowData.Button && AudioData) {
            WriteBanner(RowData, AudioData)
            // a hard refresh often re-renders the banner button after we style
            // it (turning it white again) — re-apply on each scan tick.
            bannerReapply = () => {
                const sp = GetSongPage()
                if (!sp) return
                const fresh = GetBannerData(sp, Pagetype)
                if (
                    fresh &&
                    fresh.Button &&
                    !fresh.Button.hasAttribute('artlist-dl-processed')
                ) {
                    WriteBanner(fresh, AudioData)
                }
            }
        }
    }

    LogDebug('searching for table...')
    if (IsFootagePagetype(Pagetype)) {
        // Footage pages have no audio table — don't wait for one. Use <body> as the
        // scan root so the interval starts; ProcessFootageButtons does the wiring.
        TBody = unsafeWindow.document.body
        LogDebug('footage page — skipping tbody wait')
    } else if (Pagetype === SONGS_PAGETYPE || Pagetype == MUSIC_ALBUM_PAGETYPE) {
        await Until(() => {
            return GetTBodyEdgeCase() != undefined
        }, 'tbody-edge')
        TBody = GetTBodyEdgeCase()
    } else {
        await Until(() => {
            return GetTBody() != undefined && document.contains(GetTBody())
        }, 'tbody')
        TBody = GetTBody()
        LogDebug('tbody', TBody)
    }

    function OnAudioRowAdded(AudioRow) {
        if (AudioRow.classList.contains('hidden')) {
            return true // skip hidden rows
        }
        const RowData = GetAudioRowData(AudioRow, GetPagetype())
        const AudioData = GetAudioDataFromRowData(RowData)

        return OnRowAdded(AudioRow, RowData, AudioData)
    }

    LogDebug('found')
    LastInterval = setInterval(() => {
        try {
            EnsureDownloadAllButton()
        } catch (e) {
            RecordError('EnsureDownloadAllButton', e)
        }

        // keep the banner button alive across React re-renders (refresh case)
        if (bannerReapply) {
            try {
                bannerReapply()
            } catch (e) {
                RecordError('bannerReapply', e)
            }
        }

        // SFX packs + music albums: reconstruct the server-rendered track list
        // from each row's canonical id, looked up via the search API
        if (Pagetype === SFXP_PAGETYPE || Pagetype === MUSIC_ALBUM_PAGETYPE) {
            LoadServerListAssets(Pagetype).catch(e =>
                RecordError('LoadServerListAssets', e)
            )
        }

        // "Similar songs" modal (can open over any list page): fetch + wire it
        LoadModalAssets().catch(e => RecordError('LoadModalAssets', e))
        try {
            ProcessModalRows()
        } catch (e) {
            RecordError('ProcessModalRows', e)
        }

        if (!TBody) {
            return
        }

        // ---- Footage button wiring (stock-footage pages) ----
        if (IsFootagePagetype(Pagetype)) {
            try {
                ProcessFootageButtons()
            } catch (e) {
                RecordError('ProcessFootageButtons', e)
            }
            // related SFX/music on a clip page aren't AudioRows — wire by name
            if (Pagetype === FOOTAGE_CLIP_PAGETYPE) {
                try {
                    ProcessClipPageRelatedButtons()
                } catch (e) {
                    RecordError('ProcessClipPageRelatedButtons', e)
                }
            }
        }

        for (const AudioRow of TBody.querySelectorAll(
            '[data-testid=AudioRow], [data-testid=AlbumRow], [data-testid=SongVariantsWrapper]'
        )) {
            if (!AudioRow.hasAttribute('artlist-dl-processed')) {
                try {
                    const ok = OnAudioRowAdded(AudioRow)
                    if (ok) {
                        AudioRow.setAttribute('artlist-dl-processed', 'true')
                    } else {
                        // data not captured yet — retry on later ticks (handles
                        // the refresh race), then give up after ~10s → red.
                        const tries =
                            parseInt(
                                AudioRow.getAttribute('artlist-dl-tries') || '0',
                                10
                            ) + 1
                        AudioRow.setAttribute('artlist-dl-tries', String(tries))
                        if (tries >= 20) {
                            AudioRow.setAttribute('artlist-dl-processed', 'true')
                        }
                    }
                } catch (e) {
                    RecordError('OnAudioRowAdded', e)
                    AudioRow.setAttribute('artlist-dl-processed', 'true')
                }
            }
        }

        for (const modal of document.querySelectorAll('.ReactModal__Content')) {
            for (const AllStemsDownload of modal.querySelectorAll(
                'button[data-testid=renderButton]'
            )) {
                if (
                    !AllStemsDownload.hasAttribute('artlist-dl-processed') &&
                    AllStemsDownload.parentNode.getAttribute('data-testid') ==
                        'download-all-stems-dropdown'
                ) {
                    WriteDownloadAllStems(modal, AllStemsDownload)
                }
            }
            for (const StemContainer of modal.querySelectorAll(
                'span[data-testid=stems-player-stem-name]'
            )) {
                const Stem = StemContainer.parentNode
                if (
                    !Stem.hasAttribute('artlist-dl-processed') &&
                    document.contains(Stem)
                ) {
                    try {
                        OnAudioRowAdded(Stem)
                        Stem.setAttribute('artlist-dl-processed', 'true')
                    } catch (e) {} // will fail on false positives so just hide errors
                }
            }
        }
    }, 500)
}

try {
    HookNextRSC()
} catch (e) {
    RecordError('HookNextRSC', e)
}
try {
    HookRequests()
} catch (e) {
    RecordError('HookRequests', e)
}
try {
    InstallFootageDelegation() // capture-phase click handler for footage download buttons
} catch (e) {
    RecordError('InstallFootageDelegation', e)
}
document.addEventListener('DOMContentLoaded', () => {
    try {
        EnsureSettingsUI() // mount the gear launcher + drawer shell
    } catch (e) {
        RecordError('EnsureSettingsUI(boot)', e)
    }
    Initialize().catch(e => RecordError('Initialize', e))
    setInterval(() => {
        // re-mount the gear if Artlist ever wipes body nodes
        if (!unsafeWindow.document.getElementById('artlist-dl-ui')) {
            ArtlistUI = null
            try {
                EnsureSettingsUI()
            } catch (e) {}
        }
        if (TBody != null && !document.contains(TBody)) {
            LogDebug('Re-updating...')
            DontPoll = true
            TBody = null
            AudioTable = null
            SongPage = null
            Initialize().catch(e => RecordError('Initialize(re-update)', e))
        }
    }, 1000)
})
