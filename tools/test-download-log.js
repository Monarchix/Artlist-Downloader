// Unit tests for the pure download-log core in artlist-downloader.user.js.
// Run:  node tools/test-download-log.js
//
// The userscript is a browser file with no exports, so this pulls out the block
// between the <download-log-core> markers and evaluates just that.
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')

const src = fs.readFileSync(path.join(__dirname, '..', 'artlist-downloader.user.js'), 'utf8')
const m = src.match(/\/\/ <download-log-core>([\s\S]*?)\/\/ <\/download-log-core>/)
if (!m) throw new Error('download-log-core markers not found in the userscript')

const ctx = {}
vm.createContext(ctx)
// const/function declarations are not properties of the context, so re-export.
vm.runInContext(
    m[1] + '\nthis.api = { LOG_MAX, LogKey, LogAppend, LogFailed, LogLatestOk, CsvCell, LogToCsv }',
    ctx
)
const { LOG_MAX, LogKey, LogAppend, LogFailed, LogLatestOk, CsvCell, LogToCsv } = ctx.api

const ok = (id, extra) => ({ kind: 'music', id, title: 't' + id, artist: 'a', file: id + '.mp3', status: 'ok', ...extra })
const bad = (id, extra) => ({
    kind: 'music', id, title: 't' + id, artist: 'a', file: id + '.mp3', status: 'failed',
    error: 'boom', retry: { type: 'audio', url: 'u' + id }, ...extra
})

let passed = 0
function test(name, fn) {
    try { fn(); passed++; console.log('  ok   ' + name) }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1 }
}

test('append returns a new array and leaves the input alone', () => {
    const before = [ok('1')]
    const after = LogAppend(before, ok('2'), 'T')
    assert.notStrictEqual(after, before)
    assert.strictEqual(before.length, 1)
    assert.strictEqual(after.length, 2)
    assert.strictEqual(after[1].ts, 'T')
})

test('a failed row keeps its retry payload', () => {
    const [e] = LogAppend([], bad('1'), 'T')
    assert.deepStrictEqual(e.retry, { type: 'audio', url: 'u1' })
})

test('an ok row never carries a retry payload', () => {
    const [e] = LogAppend([], { ...ok('1'), retry: { type: 'audio' } }, 'T')
    assert.ok(!('retry' in e))
})

test('a later success replaces the earlier failure of the same item', () => {
    let log = LogAppend([], bad('1'), 'T1')
    log = LogAppend(log, ok('1'), 'T2')
    assert.strictEqual(LogFailed(log).length, 0)
    assert.strictEqual(log.length, 1)
    assert.strictEqual(log[0].status, 'ok')
})

test('a repeated failure of one item does not pile up rows', () => {
    let log = LogAppend([], bad('1'), 'T1')
    log = LogAppend(log, bad('1', { error: 'again' }), 'T2')
    assert.strictEqual(LogFailed(log).length, 1)
    assert.strictEqual(log[0].error, 'again')
})

test('a success does not clear the failure of a different item', () => {
    let log = LogAppend([], bad('1'), 'T1')
    log = LogAppend(log, ok('2'), 'T2')
    assert.strictEqual(LogFailed(log).length, 1)
})

test('same id in another kind is a different item', () => {
    let log = LogAppend([], bad('1', { kind: 'sfx' }), 'T1')
    log = LogAppend(log, ok('1', { kind: 'music' }), 'T2')
    assert.strictEqual(LogFailed(log).length, 1)
})

test('re-downloading keeps both ok rows as history', () => {
    let log = LogAppend([], ok('1'), 'T1')
    log = LogAppend(log, ok('1'), 'T2')
    assert.strictEqual(log.length, 2)
})

test('items without an id fall back to the file name for identity', () => {
    assert.strictEqual(LogKey({ kind: 'music', file: 'x.mp3' }), 'music|x.mp3')
    let log = LogAppend([], bad('', { id: '', file: 'x.mp3' }), 'T1')
    log = LogAppend(log, ok('', { id: '', file: 'x.mp3' }), 'T2')
    assert.strictEqual(LogFailed(log).length, 0)
})

test('the log is capped at LOG_MAX, dropping the oldest', () => {
    let log = []
    for (let i = 0; i < LOG_MAX + 25; i++) log = LogAppend(log, ok(String(i)), 'T')
    assert.strictEqual(log.length, LOG_MAX)
    assert.strictEqual(log[0].id, '25')
    assert.strictEqual(log[log.length - 1].id, String(LOG_MAX + 24))
})

test('past the cap, failed rows survive and the oldest ok rows go first', () => {
    let log = LogAppend([], bad('keep-me'), 'T')
    for (let i = 0; i < LOG_MAX + 40; i++) log = LogAppend(log, ok('o' + i), 'T')
    assert.strictEqual(log.length, LOG_MAX)
    assert.strictEqual(LogFailed(log).length, 1)
    assert.strictEqual(log.filter(e => e.status === 'ok').length, LOG_MAX - 1)
    assert.strictEqual(log[log.length - 1].id, 'o' + (LOG_MAX + 39))
    assert.ok(!log.some(e => e.id === 'o0'))
})

test('an id-less failure is cleared by a success whose file name differs', () => {
    // Failed rows hold the bare base name; saved rows hold name + extension.
    let log = LogAppend([], bad('', { id: '', artist: 'Ann', title: 'Song', file: 'Ann - Song' }), 'T1')
    log = LogAppend(log, ok('', { id: '', artist: 'Ann', title: 'Song', file: 'Ann - Song.mp3' }), 'T2')
    assert.strictEqual(LogFailed(log).length, 0)
})

test('two different id-less songs by one artist stay separate', () => {
    let log = LogAppend([], bad('', { id: '', artist: 'Ann', title: 'One', file: 'a' }), 'T1')
    log = LogAppend(log, ok('', { id: '', artist: 'Ann', title: 'Two', file: 'b.mp3' }), 'T2')
    assert.strictEqual(LogFailed(log).length, 1)
})

test('LogLatestOk returns the newest success, ignoring failures and other ids', () => {
    let log = LogAppend([], ok('1', { file: 'old.mp3' }), 'T1')
    log = LogAppend(log, ok('1', { file: 'new.mp3' }), 'T2')
    log = LogAppend(log, bad('1'), 'T3')
    log = LogAppend(log, ok('2'), 'T4')
    assert.strictEqual(LogLatestOk(log, '1').file, 'new.mp3')
    assert.strictEqual(LogLatestOk(log, 'nope'), null)
    assert.strictEqual(LogLatestOk(log, ''), null)
})

test('CsvCell quotes, escapes quotes, and tolerates null', () => {
    assert.strictEqual(CsvCell('a,b'), '"a,b"')
    assert.strictEqual(CsvCell('say "hi"'), '"say ""hi"""')
    assert.strictEqual(CsvCell(null), '""')
    assert.strictEqual(CsvCell(undefined), '""')
})

test('CsvCell defuses spreadsheet formulas', () => {
    for (const s of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx'])
        assert.ok(CsvCell(s).startsWith('"\''), s)
    assert.strictEqual(CsvCell('Normal - title'), '"Normal - title"')
})

test('LogToCsv writes a header, the log rows, then ids known only from scans', () => {
    const log = LogAppend([], ok('1'), 'T1')
    const known = new Map([
        ['1', { name: 'dup', artist: 'x', album: '', ts: 'K' }],
        ['9', { name: 'scanned', artist: 'y', album: 'z', ts: 'K9' }]
    ])
    const lines = LogToCsv(log, known).split('\n')
    assert.strictEqual(lines.length, 3)
    assert.strictEqual(lines[0], '"id","kind","title","artist","album","file","folder","status","error","date"')
    assert.ok(lines[1].includes('"ok"') && lines[1].startsWith('"1"'))
    assert.ok(lines[2].startsWith('"9"') && lines[2].includes('"known"'))
})

test('LogToCsv works with an empty log and no known ids', () => {
    assert.strictEqual(LogToCsv([], undefined).split('\n').length, 1)
})

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''))
