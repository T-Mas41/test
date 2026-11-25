// 受領照合: 確認済み・コメントの保存、ファイルのドラッグ&ドロップ、削除確認(外部通信なし・同一オリジンのみ)
(function () {
  function save(row) {
    var fd = new FormData();
    fd.append('view', row.dataset.view);
    fd.append('key', row.dataset.key);
    var cb = row.querySelector('input[type=checkbox].js-check');
    var cm = row.querySelector('input.js-comment');
    fd.append('checked', cb && cb.checked ? '1' : '');
    fd.append('comment', cm ? cm.value : '');
    return fetch(row.dataset.url, { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '保存に失敗しました');
        if (cm) { cm.classList.remove('err'); cm.classList.add('saved'); setTimeout(function () { cm.classList.remove('saved'); }, 1200); }
      })
      .catch(function (e) { if (cm) cm.classList.add('err'); alert(e.message); });
  }
  document.querySelectorAll('tr.js-conf').forEach(function (row) {
    var cb = row.querySelector('input.js-check');
    var cm = row.querySelector('input.js-comment');
    if (cb) cb.addEventListener('change', function () { save(row); });
    if (cm) {
      cm.addEventListener('change', function () { save(row); });
      cm.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); cm.blur(); } });
    }
  });
  document.querySelectorAll('.drop').forEach(function (d) {
    var inp = d.querySelector('input[type=file]');
    ['dragenter', 'dragover'].forEach(function (t) { d.addEventListener(t, function (e) { e.preventDefault(); d.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { d.addEventListener(t, function (e) { e.preventDefault(); d.classList.remove('over'); }); });
    d.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) { inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change')); } });
    inp.addEventListener('change', function () { var n = d.querySelector('.fname'); if (n) n.textContent = inp.files.length ? '選択中: ' + inp.files[0].name : ''; });
  });
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
  });
  document.querySelectorAll('form.js-busy').forEach(function (f) {
    f.addEventListener('submit', function () { var b = f.querySelector('button[type=submit]'); if (b) { b.disabled = true; b.textContent = '処理中…'; } });
  });
  document.querySelectorAll('.js-autosubmit').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });
  var fileType = document.querySelector('select[name=file_type]');
  if (fileType) {
    var sync = function () {
      document.querySelectorAll('.js-csv').forEach(function (el) { el.style.display = fileType.value === 'csv' ? '' : 'none'; });
      document.querySelectorAll('.js-excel').forEach(function (el) { el.style.display = fileType.value === 'excel' ? '' : 'none'; });
    };
    fileType.addEventListener('change', sync); sync();
  }
})();
