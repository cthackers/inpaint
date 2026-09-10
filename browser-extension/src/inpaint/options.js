import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
let settings;

async function init() {
    settings = await loadSettings();
    $('app-url').value = settings.appUrl;
    $('token').value = settings.token;
    $('immich-url').value = settings.immich.url;
    $('immich-key').value = settings.immich.apiKey;
    renderMappings();
}

function field(value, placeholder, onInput) {
    const input = document.createElement('input');
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    return input;
}

function renderMappings() {
    const list = $('mappings');
    list.replaceChildren();
    settings.immich.mappings.forEach((mapping, index) => {
        const remove = document.createElement('button');
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
            settings.immich.mappings.splice(index, 1);
            renderMappings();
        });
        const row = document.createElement('div');
        row.className = 'mapping';
        row.append(
            field(mapping.immichPath, 'Immich path, e.g. /mnt/library', (value) => { mapping.immichPath = value; }),
            field(mapping.localPath, 'Local path, e.g. /media/nas/photos', (value) => { mapping.localPath = value; }),
            remove
        );
        list.append(row);
    });
}

async function save(resultId) {
    const appUrl = $('app-url').value.trim() || DEFAULT_SETTINGS.appUrl;
    const immichUrl = $('immich-url').value.trim();
    for (const url of [appUrl, immichUrl].filter(Boolean)) {
        if (!/^https?:\/\/[^/]/i.test(url)) {
            $(resultId).textContent = `${url} is not an http(s) address.`;
            return false;
        }
    }
    settings.appUrl = appUrl;
    settings.token = $('token').value.trim();
    settings.immich.url = immichUrl;
    settings.immich.apiKey = $('immich-key').value.trim();
    settings.immich.mappings = settings.immich.mappings.filter((mapping) => mapping.immichPath?.trim() || mapping.localPath?.trim());
    await saveSettings(settings);
    renderMappings();
    $(resultId).textContent = 'Saved.';
    return true;
}

async function test(type, resultId, describe) {
    if (!await save(resultId)) return;
    $(resultId).textContent = 'Testing…';
    const reply = await chrome.runtime.sendMessage({ type });
    $(resultId).textContent = reply.ok ? describe(reply) : reply.error;
}

$('save').addEventListener('click', () => save('save-result'));
$('add-mapping').addEventListener('click', () => {
    settings.immich.mappings.push({ immichPath: '', localPath: '' });
    renderMappings();
});
$('app-test').addEventListener('click', () => test('inpaint:status', 'app-result', (reply) => (reply.ready
    ? `Connected to Inpaint ${reply.version}: ${reply.operations.length} operations, ${reply.workflows.length} workflows.`
    : reply.error)));
$('immich-test').addEventListener('click', () => test('inpaint:test-immich', 'immich-result', (reply) => reply.message));

init();
