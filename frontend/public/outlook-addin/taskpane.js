/* global Office */

;(function () {
  'use strict'

  const RS_KEY = 'canary_jwt'
  /** Same-origin backup when ``roamingSettings`` is empty (common in Outlook on the web). */
  const LS_KEY = 'canary_outlook_addin_jwt'
  /** Outlook master + item category applied after a successful file (client-only). */
  const CANARY_CATEGORY = 'Canary'
  /** Bumped when task pane logic changes — shown in error text so you can confirm the browser loaded the new bundle. */
  const ADDIN_UI_VERSION = '1.0.6.2'
  const CATEGORY_APPLY_ATTEMPTS = 3
  const CATEGORY_RETRY_DELAY_MS = 450

  function pageOrigin() {
    const u = new URL(window.location.href)
    return u.origin
  }

  /** Same convention as the main SPA when ``VITE_API_BASE`` is unset: ``/api`` on the UI origin. */
  function apiRoot() {
    return pageOrigin() + '/api'
  }

  function $(id) {
    return document.getElementById(id)
  }

  /** @type {Array<{ id: unknown, case_number?: unknown, client_name?: unknown, matter_description?: unknown }>} */
  let allCases = []
  let selectedCaseId = ''
  /** Case id from ``/outlook-plugin/linked-case`` for the current mail item (if any). */
  let linkedCaseId = ''

  function show(elId, text, asError) {
    const el = $(elId)
    if (!el) return
    el.style.display = text ? 'block' : 'none'
    el.textContent = text || ''
    el.className = asError ? 'error' : 'ok'
  }

  function sanitizeFilename(name) {
    let n = String(name || '').trim()
    if (!n) return 'attachment'
    n = n.replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')
    return n || 'attachment'
  }

  function randomMessageId() {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0
            const v = c === 'x' ? r : (r & 0x3) | 0x8
            return v.toString(16)
          })
    return `<${id}@canary-outlook-addin>`
  }

  function wrapMessageId(id) {
    const s = String(id || '').trim()
    if (!s) return randomMessageId()
    if (s.startsWith('<')) return s
    return `<${s}>`
  }

  function formatRecipients(list) {
    if (!list || !list.length) return ''
    return list
      .map((r) => {
        if (!r) return ''
        const em = String(r.emailAddress || '').trim()
        let name = String(r.displayName || '').trim().replace(/"/g, '')
        if (name) return `"${name}" <${em}>`
        return em
      })
      .filter(Boolean)
      .join(', ')
  }

  function rfc2822(d) {
    try {
      return new Date(d).toUTCString()
    } catch {
      return new Date().toUTCString()
    }
  }

  function getToken() {
    try {
      const fromLs = localStorage.getItem(LS_KEY)
      if (fromLs) return String(fromLs)
    } catch {
      /* ignore */
    }
    try {
      return Office.context.roamingSettings.get(RS_KEY) || ''
    } catch {
      return ''
    }
  }

  /**
   * Persist JWT: write ``localStorage`` first (reliable in Outlook on the web), then roaming settings.
   * Roaming alone is often empty on read right after login; ``localStorage`` keeps the session usable.
   */
  function persistTokenAsync(token) {
    const v = token || ''
    try {
      if (v) localStorage.setItem(LS_KEY, v)
      else localStorage.removeItem(LS_KEY)
    } catch (e) {
      return Promise.reject(e)
    }
    return new Promise((resolve, reject) => {
      try {
        Office.context.roamingSettings.set(RS_KEY, v)
        Office.context.roamingSettings.saveAsync((r) => {
          if (r.status === Office.AsyncResultStatus.Succeeded) {
            resolve()
            return
          }
          if (v) resolve()
          else reject(new Error(r.error ? r.error.message : 'Could not clear sign-in.'))
        })
      } catch (e) {
        if (v) resolve()
        else reject(e)
      }
    })
  }

  function setAuthPanels(signedIn) {
    const pre = $('panel-pre-auth')
    const post = $('panel-post-auth')
    if (pre) pre.classList.toggle('panel-hidden', !!signedIn)
    if (post) post.classList.toggle('panel-hidden', !signedIn)
    if (signedIn) syncMailDescriptionField()
  }

  function mailItemSubject() {
    try {
      const item = Office.context.mailbox && Office.context.mailbox.item
      return String(item && item.subject ? item.subject : 'email').trim() || 'email'
    } catch {
      return 'email'
    }
  }

  function syncMailDescriptionField() {
    const el = $('mail-description')
    if (!el) return
    if (el.dataset.userEdited === '1') return
    el.value = mailItemSubject()
  }

  function resetMailDescriptionField() {
    const el = $('mail-description')
    if (!el) return
    el.value = ''
    delete el.dataset.userEdited
  }

  function loginShowErr(msg) {
    const el = $('login-err')
    if (!el) return
    el.style.display = msg ? 'block' : 'none'
    el.textContent = msg || ''
  }

  async function submitLogin() {
    loginShowErr('')
    show('msg', '', true)
    show('ok', '', false)
    const email = ($('login-email') && $('login-email').value.trim()) || ''
    const password = ($('login-password') && $('login-password').value) || ''
    const totp = ($('login-totp') && $('login-totp').value.trim()) || ''
    if (!email || !password) {
      loginShowErr('Email and password are required.')
      return
    }
    try {
      const res = await fetch(apiRoot() + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          totp_code: totp || null,
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const detail = body && typeof body === 'object' && body.detail
        const msg =
          typeof detail === 'string'
            ? detail
            : res.status === 401
              ? 'Invalid credentials or 2FA required.'
              : 'Sign-in failed.'
        loginShowErr(msg)
        return
      }
      const token = body && body.access_token
      if (!token) {
        loginShowErr('No access token returned.')
        return
      }
      await persistTokenAsync(token)
      if ($('login-password')) $('login-password').value = ''
      if ($('login-totp')) $('login-totp').value = ''
      await refreshAuthAndCases()
    } catch (e) {
      loginShowErr(e && e.message ? String(e.message) : 'Network error.')
    }
  }

  function authHeaders(token) {
    const h = new Headers()
    if (token) h.set('Authorization', 'Bearer ' + token)
    h.set('Accept', 'application/json')
    return h
  }

  function jsonAuthHeaders(token) {
    const h = authHeaders(token)
    h.set('Content-Type', 'application/json')
    return h
  }

  /**
   * Best-effort: seed the mailbox master category list via Canary API + Microsoft Graph (app-only),
   * so Office.js can apply the Canary category without each user creating it manually in Outlook.
   * Safe to ignore failures — filing still runs ``applyCanaryOutlookCategoryWithRetries``.
   */
  async function ensureMasterCategoryViaCanaryApi() {
    const token = getToken()
    if (!token) return
    var mailbox = ''
    try {
      var prof = Office.context.mailbox && Office.context.mailbox.userProfile
      if (prof && prof.emailAddress) mailbox = String(prof.emailAddress).trim()
    } catch (_) {}
    if (!mailbox) return
    try {
      await fetch(apiRoot() + '/outlook-plugin/ensure-master-category', {
        method: 'POST',
        headers: jsonAuthHeaders(token),
        body: JSON.stringify({ mailbox: mailbox }),
      })
    } catch (_) {
      /* optional Graph path */
    }
  }

  /**
   * Graph expects a REST message id. Raw ``item.itemId`` is often EWS-shaped (slashes/base64);
   * use ``mailbox.convertToRestId(..., v2.0)`` when available or Graph returns ParseUri / segment errors.
   */
  function graphRestItemIdFromItem(item) {
    if (!item || !item.itemId) return ''
    var raw = String(item.itemId).trim()
    try {
      var mb = Office.context.mailbox
      if (mb && typeof mb.convertToRestId === 'function') {
        var RV = Office.MailboxEnums && Office.MailboxEnums.RestVersion
        var ver = RV && RV.v2_0 != null ? RV.v2_0 : 'v2.0'
        var converted = mb.convertToRestId(raw, ver)
        if (converted) return String(converted).trim()
      }
    } catch (_) {
      /* fall through */
    }
    return raw
  }

  /**
   * When Office.js cannot set ``categories``, PATCH the message via Canary API + Graph (Mail.ReadWrite app).
   * @returns {Promise<'ok'|string>} ``'ok'`` or an error detail string
   */
  async function applyCategoryTagViaCanaryGraph(item, token) {
    var mailbox = ''
    try {
      var prof = Office.context.mailbox && Office.context.mailbox.userProfile
      if (prof && prof.emailAddress) mailbox = String(prof.emailAddress).trim()
    } catch (_) {}
    var restId = graphRestItemIdFromItem(item)
    var internetMid = ''
    try {
      if (item && item.internetMessageId) internetMid = String(item.internetMessageId).trim()
    } catch (_) {}
    if (!mailbox || !restId) {
      return 'Missing mailbox or item id for Graph tagging.'
    }
    try {
      const res = await fetch(apiRoot() + '/outlook-plugin/graph-tag-category', {
        method: 'POST',
        headers: jsonAuthHeaders(token),
        body: JSON.stringify({
          mailbox: mailbox,
          rest_item_id: restId,
          internet_message_id: internetMid || null,
        }),
      })
      const body = await res.json().catch(function () {
        return null
      })
      if (body && body.ok === true) return 'ok'
      const det = body && body.detail
      if (typeof det === 'string' && det) return det
      return 'Graph tag failed (HTTP ' + res.status + ').'
    } catch (e) {
      return e && e.message ? String(e.message) : 'Graph tag request failed.'
    }
  }

  async function apiGetCases(token) {
    const res = await fetch(apiRoot() + '/cases', { headers: authHeaders(token) })
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      if (res.status === 401) throw new Error('401 Unauthorized')
      const detail = body && typeof body === 'object' && body.detail
      const msg = typeof detail === 'string' ? detail : 'Could not load matters.'
      throw new Error(msg)
    }
    if (!Array.isArray(body)) {
      if (ct.includes('text/html')) {
        throw new Error('Matters request returned HTML (wrong API URL or session).')
      }
      throw new Error('Matters request returned an unexpected JSON shape.')
    }
    return body
  }

  async function apiGetMe(token) {
    const res = await fetch(apiRoot() + '/auth/me', { headers: authHeaders(token) })
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      if (res.status === 401) throw new Error('401 Unauthorized')
      const detail = body && typeof body === 'object' && body.detail
      const msg = typeof detail === 'string' ? detail : 'Could not verify session.'
      throw new Error(msg)
    }
    if (!body || typeof body !== 'object' || !body.email) {
      if (ct.includes('text/html')) {
        throw new Error('Session check returned HTML (wrong API URL).')
      }
      throw new Error('Session check returned an unexpected response.')
    }
    return body
  }

  async function uploadMultipart(token, caseId, { blob, filename, mime, parentFileId, outlookItemId }) {
    const fd = new FormData()
    fd.append('upload', blob, filename)
    fd.append('folder', '')
    if (parentFileId) fd.append('parent_file_id', parentFileId)
    else if (outlookItemId) fd.append('outlook_item_id', outlookItemId)

    const res = await fetch(apiRoot() + '/cases/' + encodeURIComponent(caseId) + '/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd,
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = body && typeof body === 'object' && body.detail
      const msg = typeof detail === 'string' ? detail : 'Upload failed (' + res.status + ')'
      throw new Error(msg)
    }
    if (!body || typeof body !== 'object' || !body.id) {
      throw new Error('Upload succeeded but no file id returned.')
    }
    return body
  }

  function base64ToBlob(base64, mime) {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
  }

  function getAttachmentTypeEnum() {
    return Office.MailboxEnums && Office.MailboxEnums.AttachmentType ? Office.MailboxEnums.AttachmentType : null
  }

  function shouldSkipAttachment(att) {
    if (!att || !att.id) return true
    const T = getAttachmentTypeEnum()
    if (T && att.attachmentType === T.Reference) return true
    return false
  }

  function getBodyAsync(item, coercionType) {
    return new Promise((resolve, reject) => {
      try {
        item.body.getAsync(coercionType, (r) => {
          if (r.status !== Office.AsyncResultStatus.Succeeded) {
            reject(new Error(r.error ? r.error.message : 'getAsync failed'))
            return
          }
          resolve(String(r.value || ''))
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  function getAttachmentContentAsync(item, id) {
    return new Promise((resolve, reject) => {
      try {
        item.getAttachmentContentAsync(id, (r) => {
          if (r.status !== Office.AsyncResultStatus.Succeeded) {
            reject(new Error(r.error ? r.error.message : 'getAttachmentContentAsync failed'))
            return
          }
          resolve(r.value)
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  function buildSyntheticEml(item, bodyText, displaySubject) {
    const subj =
      displaySubject != null && String(displaySubject).trim() !== ''
        ? String(displaySubject).trim()
        : String(item.subject || '(no subject)')
    const fromDisp = item.from ? formatRecipients([item.from]) : ''
    const toDisp = formatRecipients(item.to || [])
    const ccDisp = formatRecipients(item.cc || [])
    const when = item.dateTimeModified || item.dateTimeCreated || new Date().toISOString()
    const mid = wrapMessageId(item.internetMessageId)

    let hdr = ''
    hdr += 'From: ' + fromDisp + '\r\n'
    if (toDisp) hdr += 'To: ' + toDisp + '\r\n'
    if (ccDisp) hdr += 'Cc: ' + ccDisp + '\r\n'
    hdr += 'Subject: ' + subj.replace(/\r|\n/g, ' ') + '\r\n'
    hdr += 'Date: ' + rfc2822(when) + '\r\n'
    hdr += 'Message-ID: ' + mid + '\r\n'
    hdr += 'MIME-Version: 1.0\r\n'
    hdr += 'Content-Type: text/plain; charset="utf-8"\r\n'
    hdr += '\r\n'
    hdr += (bodyText || '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    return new Blob([hdr], { type: 'message/rfc822' })
  }

  function matterLabel(c) {
    const num = c.case_number != null ? String(c.case_number) : ''
    const client = c.client_name ? String(c.client_name) : ''
    const title = c.matter_description ? String(c.matter_description) : ''
    const primary = [num, client].filter(Boolean).join(' — ') || String(c.id)
    return title ? primary + ' — ' + title : primary
  }

  function matterSearchText(c) {
    return matterLabel(c).toLowerCase()
  }

  function filterCases(query) {
    const q = String(query || '')
      .trim()
      .toLowerCase()
    if (!q) return []
    return allCases.filter((c) => matterSearchText(c).includes(q))
  }

  function setCaseSelection(caseId, labelText) {
    selectedCaseId = caseId ? String(caseId) : ''
    const selEl = $('case-selected')
    if (selEl) {
      if (selectedCaseId && labelText) {
        selEl.hidden = false
        selEl.textContent = 'Selected: ' + labelText
      } else {
        selEl.hidden = true
        selEl.textContent = ''
      }
    }
    const fileBtn = $('btn-file')
    if (fileBtn) fileBtn.disabled = !selectedCaseId
  }

  function renderCaseResults() {
    const box = $('case-results')
    const input = $('case-search')
    if (!box || !input) return

    if (input.disabled || !allCases.length) {
      box.innerHTML = ''
      box.hidden = true
      return
    }

    const q = String(input.value || '').trim()
    box.innerHTML = ''

    if (!q) {
      const hint = document.createElement('div')
      hint.className = 'case-results-empty muted'
      hint.textContent = 'Type in the box to search matters.'
      box.appendChild(hint)
      box.hidden = false
      return
    }

    const matches = filterCases(input.value)
    if (!matches.length) {
      const empty = document.createElement('div')
      empty.className = 'case-results-empty muted'
      empty.textContent = 'No matters match your search.'
      box.appendChild(empty)
      box.hidden = false
      return
    }

    const maxRows = 80
    const rows = matches.length > maxRows ? matches.slice(0, maxRows) : matches
    for (const c of rows) {
      const id = String(c.id)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'case-result-row' + (id === selectedCaseId ? ' is-selected' : '')
      btn.setAttribute('role', 'option')
      btn.dataset.caseId = id
      btn.textContent = matterLabel(c)
      btn.onclick = () => {
        setCaseSelection(id, matterLabel(c))
        void renderCaseResults()
      }
      box.appendChild(btn)
    }

    if (matches.length > maxRows) {
      const more = document.createElement('div')
      more.className = 'case-results-more muted'
      more.textContent =
        'Showing ' + maxRows + ' of ' + matches.length + ' matches. Type more to narrow the list.'
      box.appendChild(more)
    }

    box.hidden = false
  }

  /**
   * If this message was already filed to Canary, select that matter. Otherwise clear selection.
   * Uses Outlook item id + internet Message-ID against stored file metadata.
   */
  async function refreshLinkedCaseForCurrentItem() {
    const token = getToken()
    if (!token) {
      linkedCaseId = ''
      setCaseSelection('', '')
      renderCaseResults()
      return
    }

    var item = null
    try {
      item = Office.context.mailbox && Office.context.mailbox.item
    } catch (_) {
      linkedCaseId = ''
      setCaseSelection('', '')
      renderCaseResults()
      return
    }

    var Msg = Office.MailboxEnums && Office.MailboxEnums.ItemType && Office.MailboxEnums.ItemType.Message
    if (!item || (Msg != null && item.itemType !== Msg)) {
      linkedCaseId = ''
      setCaseSelection('', '')
      renderCaseResults()
      return
    }

    var oid = ''
    var imid = ''
    try {
      if (item.itemId) oid = String(item.itemId)
    } catch (_) {}
    try {
      if (item.internetMessageId) imid = String(item.internetMessageId)
    } catch (_) {}

    if (!oid && !imid) {
      linkedCaseId = ''
      setCaseSelection('', '')
      renderCaseResults()
      return
    }

    try {
      const res = await fetch(apiRoot() + '/outlook-plugin/linked-case', {
        method: 'POST',
        headers: jsonAuthHeaders(token),
        body: JSON.stringify({
          outlook_item_id: oid || null,
          internet_message_id: imid || null,
        }),
      })
      const body = await res.json().catch(function () {
        return null
      })
      if (!res.ok) {
        linkedCaseId = ''
        setCaseSelection('', '')
        renderCaseResults()
        return
      }
      const lc = body && body.linked_case
      if (lc && lc.id) {
        linkedCaseId = String(lc.id)
        setCaseSelection(linkedCaseId, matterLabel(lc))
      } else {
        linkedCaseId = ''
        setCaseSelection('', '')
      }
    } catch (_) {
      linkedCaseId = ''
      setCaseSelection('', '')
    }
    renderCaseResults()
  }

  /** Called when the user selects a different message (pinned task pane + ItemChanged). */
  function onMailItemChanged() {
    show('msg', '', true)
    show('ok', '', false)
    resetMailDescriptionField()
    syncMailDescriptionField()
    var si = $('case-search')
    if (si) si.value = ''
    linkedCaseId = ''
    setCaseSelection('', '')
    void refreshLinkedCaseForCurrentItem()
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function categoryNameFromEntry(entry) {
    if (!entry) return ''
    if (typeof entry === 'string') return entry
    return String(entry.displayName || entry.name || '')
  }

  function hasCanaryCategory(entries) {
    const list = Array.isArray(entries) ? entries : []
    return list.some((e) => categoryNameFromEntry(e).trim().toLowerCase() === CANARY_CATEGORY.toLowerCase())
  }

  /**
   * True only for errors that indicate the host blocked APIs for lack of mailbox permission.
   * Avoid a bare /denied/ match — many unrelated Outlook strings contain “denied”.
   */
  function isElevatedPermissionMessage(msg) {
    const s = String(msg || '')
    return (
      /elevated permission|permission is required to perform this operation|requires?\s+elevated\s+permission/i.test(
        s,
      ) ||
      /\baccess denied\b.*(mailbox|category|master)/i.test(s) ||
      /\bnot authorized\b.*(mailbox|operation)/i.test(s) ||
      /\binsufficient\s+(permission|privileges?)\b/i.test(s)
    )
  }

  function categoryMasterPermissionHint() {
    return (
      'Your message was saved to Canary, but Outlook would not let the add-in tag it automatically. ' +
      'Confirm the add-in manifest requests ReadWriteMailbox, re-upload it in Microsoft 365 (or sideload again), and fully restart Outlook so the permission applies. ' +
      'Or, once per mailbox, create an Outlook master category named exactly “Canary” (Home → Categorize → Categories), then use File to Case again on this message.'
    )
  }

  /** Prefer a concrete client message when it is not a generic “need permission” case. */
  function categoryFailureMessage(mItem, mMaster) {
    const a = String(mItem || '').trim()
    const b = String(mMaster || '').trim()
    if (/master categories are not available|item categories are not available|categories are not supported/i.test(a + ' ' + b)) {
      return (
        'Filed to Canary, but Outlook could not use categories in this client: ' +
        (b || a).slice(0, 280)
      )
    }
    if (isElevatedPermissionMessage(a) || isElevatedPermissionMessage(b)) {
      const detail = (b || a).trim()
      return detail
        ? categoryMasterPermissionHint() + ' Outlook detail: ' + detail.slice(0, 220)
        : categoryMasterPermissionHint()
    }
    const raw = b || a || 'Category tagging failed.'
    return 'Filed to Canary, but the Outlook category step failed: ' + raw.slice(0, 400)
  }

  function pickCanaryMasterColor() {
    try {
      const C = Office.MailboxEnums && Office.MailboxEnums.CategoryColor
      if (C && C.Preset4 != null) return C.Preset4
      if (C && C.Preset9 != null) return C.Preset9
    } catch (_) {
      /* ignore */
    }
    return 'Preset4'
  }

  function masterCategoriesGetAsync() {
    return new Promise((resolve, reject) => {
      try {
        const mc = Office.context.mailbox.masterCategories
        if (!mc || typeof mc.getAsync !== 'function') {
          reject(new Error('Master categories are not available in this Outlook client.'))
          return
        }
        mc.getAsync((r) => {
          if (r.status !== Office.AsyncResultStatus.Succeeded) {
            reject(new Error(r.error ? r.error.message : 'masterCategories.getAsync failed.'))
            return
          }
          resolve(r.value || [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  function masterCategoriesAddAsync(details) {
    return new Promise((resolve, reject) => {
      try {
        Office.context.mailbox.masterCategories.addAsync(details, (r) => {
          if (r.status === Office.AsyncResultStatus.Succeeded) {
            resolve()
            return
          }
          const msg = (r.error && r.error.message) || ''
          if (/already exists|duplicate|same name|already in the master/i.test(msg)) {
            resolve()
            return
          }
          reject(new Error(msg || 'masterCategories.addAsync failed.'))
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  function itemCategoriesGetAsync(item) {
    return new Promise((resolve, reject) => {
      try {
        if (!item || !item.categories || typeof item.categories.getAsync !== 'function') {
          reject(new Error('Item categories are not available.'))
          return
        }
        item.categories.getAsync((r) => {
          if (r.status !== Office.AsyncResultStatus.Succeeded) {
            reject(new Error(r.error ? r.error.message : 'categories.getAsync failed.'))
            return
          }
          resolve(r.value || [])
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  function itemCategoriesAddAsync(item, names) {
    return new Promise((resolve, reject) => {
      try {
        item.categories.addAsync(names, (r) => {
          if (r.status === Office.AsyncResultStatus.Succeeded) {
            resolve()
            return
          }
          const msg = (r.error && r.error.message) || ''
          if (/already been assigned|already exists|duplicate|already applied|same category|in the list/i.test(msg)) {
            resolve()
            return
          }
          reject(new Error(msg || 'categories.addAsync failed.'))
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  async function ensureMasterCanaryCategoryAsync() {
    let existing = []
    try {
      existing = await masterCategoriesGetAsync()
    } catch (e) {
      throw e
    }
    if (hasCanaryCategory(existing)) return
    await masterCategoriesAddAsync([{ displayName: CANARY_CATEGORY, color: pickCanaryMasterColor() }])
  }

  async function ensureItemCanaryCategoryAsync(item) {
    await itemCategoriesAddAsync(item, [CANARY_CATEGORY])
  }

  async function applyCanaryOutlookCategoryWithRetries(item) {
    if (!item || !item.categories || typeof item.categories.addAsync !== 'function') {
      return 'Categories are not supported for this message in this Outlook client.'
    }
    let lastErr = 'Unknown error.'
    for (let attempt = 1; attempt <= CATEGORY_APPLY_ATTEMPTS; attempt++) {
      try {
        await ensureItemCanaryCategoryAsync(item)
        return null
      } catch (eItem) {
        const mItem = eItem && eItem.message ? String(eItem.message) : ''
        try {
          await ensureMasterCanaryCategoryAsync()
          await ensureItemCanaryCategoryAsync(item)
          return null
        } catch (eMaster) {
          const mMaster = eMaster && eMaster.message ? String(eMaster.message) : ''
          lastErr = categoryFailureMessage(mItem, mMaster)
        }
      }
      if (attempt < CATEGORY_APPLY_ATTEMPTS) await delay(CATEGORY_RETRY_DELAY_MS)
    }
    return lastErr
  }

  async function fileMessageToCase(token, caseId) {
    const item = Office.context.mailbox.item
    if (!item) throw new Error('No item is available.')

    if (item.itemType !== Office.MailboxEnums.ItemType.Message) {
      throw new Error('Only mail messages can be filed (not meetings or other item types).')
    }

    show('msg', '', true)
    show('ok', '', false)

    let bodyText = ''
    try {
      bodyText = await getBodyAsync(item, Office.CoercionType.Text)
    } catch {
      bodyText = ''
    }
    if (!bodyText || !bodyText.trim()) {
      try {
        const html = await getBodyAsync(item, Office.CoercionType.Html)
        bodyText = String(html || '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
      } catch {
        bodyText = ''
      }
    }

    const descEl = $('mail-description')
    const descRaw = descEl ? String(descEl.value || '').trim() : ''
    const displayBase = descRaw || mailItemSubject()
    const parentName = sanitizeFilename(displayBase) + '.eml'
    const parentBlob = buildSyntheticEml(item, bodyText, displayBase)

    var outlookItemIdForParent = ''
    try {
      var mailItem = Office.context.mailbox && Office.context.mailbox.item
      if (mailItem && mailItem.itemId) outlookItemIdForParent = String(mailItem.itemId)
    } catch (_) {
      /* ignore */
    }
    const parent = await uploadMultipart(token, caseId, {
      blob: parentBlob,
      filename: parentName,
      mime: 'message/rfc822',
      parentFileId: null,
      outlookItemId: outlookItemIdForParent || undefined,
    })
    const parentId = parent.id

    const atts = item.attachments || []
    let n = 0
    for (const a of atts) {
      if (shouldSkipAttachment(a)) {
        continue
      }
      const name = sanitizeFilename(a.name || 'attachment')
      const mime = (a.contentType || 'application/octet-stream').split(';')[0].trim()
      const content = await getAttachmentContentAsync(item, a.id)
      const b64 = content && content.content
      if (!b64) {
        continue
      }
      const blob = base64ToBlob(b64, mime)
      await uploadMultipart(token, caseId, {
        blob,
        filename: name,
        mime,
        parentFileId: parentId,
      })
      n++
    }

    show('ok', 'Filed to Canary: parent .eml plus ' + n + ' attachment(s).', false)

    const catWarn = await applyCanaryOutlookCategoryWithRetries(item)
    if (catWarn) {
      const graphResult = await applyCategoryTagViaCanaryGraph(item, token)
      if (graphResult === 'ok') {
        show('msg', '', true)
        show(
          'ok',
          'Filed to Canary: parent .eml plus ' +
            n +
            ' attachment(s). Category “' +
            CANARY_CATEGORY +
            '” applied via Microsoft 365 (Graph).',
          false,
        )
      } else {
        show(
          'msg',
          '[' +
            ADDIN_UI_VERSION +
            '] Filed to Canary. Outlook could not apply the category; Graph fallback failed: ' +
            graphResult +
            ' — Office.js: ' +
            catWarn,
          true,
        )
      }
    }
    void refreshLinkedCaseForCurrentItem()
  }

  async function refreshAuthAndCases() {
    const token = getToken()
    linkedCaseId = ''
    $('auth-status').textContent = token ? 'Loading…' : ''
    $('btn-file').disabled = true
    const searchInput = $('case-search')
    if (searchInput) {
      searchInput.value = ''
      searchInput.disabled = true
    }
    allCases = []
    setCaseSelection('', '')
    const results = $('case-results')
    if (results) {
      results.innerHTML = ''
      results.hidden = true
    }

    if (!token) {
      setAuthPanels(false)
      loginShowErr('')
      if (searchInput) {
        searchInput.disabled = true
        searchInput.placeholder = 'Sign in to search matters'
      }
      return
    }

    setAuthPanels(true)

    try {
      const cases = await apiGetCases(token)
      allCases = Array.isArray(cases) ? cases : []
      let meEmail = ''
      try {
        const me = await apiGetMe(token)
        if (me && me.email) meEmail = String(me.email)
      } catch {
        /* matters loaded; session line is optional */
      }
      const who = meEmail ? 'Signed in as ' + meEmail : 'Signed in'
      $('auth-status').textContent = who + ' · ' + allCases.length + ' matter(s).'
      if (searchInput) {
        searchInput.disabled = false
        searchInput.placeholder = allCases.length
          ? 'Type to search…'
          : 'No matters yet — create one in Canary web'
      }
      await refreshLinkedCaseForCurrentItem()
      void ensureMasterCategoryViaCanaryApi()
    } catch (e) {
      const msg = e && e.message ? String(e.message) : 'Failed to load matters.'
      show('msg', msg, true)
      if (msg === '401 Unauthorized') {
        try {
          await persistTokenAsync('')
        } catch {
          /* ignore */
        }
        $('auth-status').textContent = ''
        resetMailDescriptionField()
        setAuthPanels(false)
      }
      allCases = []
      if (searchInput) {
        searchInput.disabled = true
        searchInput.placeholder = 'Sign in to search matters'
      }
      if (results) {
        results.innerHTML = ''
        results.hidden = true
      }
      if (msg !== '401 Unauthorized' && getToken() && searchInput) {
        searchInput.disabled = false
        searchInput.placeholder = 'Type to search…'
      }
    }
  }

  Office.onReady(() => {
    const signIn = $('btn-sign-in')
    if (signIn) {
      signIn.onclick = () => {
        void submitLogin()
      }
    }
    const loginEmail = $('login-email')
    if (loginEmail) {
      loginEmail.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') void submitLogin()
      })
    }
    const loginPw = $('login-password')
    if (loginPw) {
      loginPw.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') void submitLogin()
      })
    }
    const mailDesc = $('mail-description')
    if (mailDesc) {
      mailDesc.addEventListener('input', () => {
        mailDesc.dataset.userEdited = '1'
      })
    }
    $('btn-logout').onclick = () => {
      void (async () => {
        try {
          linkedCaseId = ''
          resetMailDescriptionField()
          await persistTokenAsync('')
          await refreshAuthAndCases()
        } catch (e) {
          show('msg', e && e.message ? String(e.message) : 'Could not sign out.', true)
        }
      })()
    }
    const searchInput = $('case-search')
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (selectedCaseId) {
          const visible = filterCases(searchInput.value)
          const still = visible.some((c) => String(c.id) === selectedCaseId)
          const linked = linkedCaseId && String(linkedCaseId) === String(selectedCaseId)
          if (!still && !linked) setCaseSelection('', '')
        }
        renderCaseResults()
      })
    }
    $('btn-file').onclick = async () => {
      const token = getToken()
      const caseId = selectedCaseId
      const item = Office.context.mailbox.item
      if (!token || !caseId) return
      $('btn-file').disabled = true
      try {
        if (item && item.categories && typeof item.categories.getAsync === 'function') {
          try {
            const cats = await itemCategoriesGetAsync(item)
            if (hasCanaryCategory(cats)) {
              const ok = window.confirm(
                'This message already has the “Canary” Outlook category (it may already be filed). Do you want to file it to Canary again?',
              )
              if (!ok) return
            }
          } catch {
            /* ignore — do not block filing */
          }
        }
        await fileMessageToCase(token, caseId)
      } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Failed.'
        show('msg', msg, true)
      } finally {
        $('btn-file').disabled = false
      }
    }

    void refreshAuthAndCases()

    try {
      if (Office.context.mailbox && typeof Office.context.mailbox.addHandlerAsync === 'function') {
        Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, function () {
          onMailItemChanged()
        })
      }
    } catch (_) {
      /* Pinned read pane + ItemChanged (not declared in manifest — schema only allows SupportsPinning, etc.) */
    }
  })
})()
