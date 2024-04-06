let settings = {
  headers: {},
  mergeStrategy: 'replace',
  transitions: false,
}

let doMorph = (from, to) => {
  console.error(`You can't use the "morph" merge without first installing the Alpine "morph" plugin here: https://alpinejs.dev/plugins/morph`)
};

function Ajax(Alpine) {
  if (Alpine.morph) doMorph = Alpine.morph

  Alpine.directive('target', (el, { modifiers, expression }) => {
    AjaxAttributes.set(el, {
      targets: parseTargetIds(el, expression),
      focus: !modifiers.includes('nofocus'),
      history: modifiers.includes('push') ? 'push' : (modifiers.includes('replace') ? 'replace' : false)
    })
  })

  Alpine.directive('headers', (el, { expression }, { evaluate }) => {
    AjaxAttributes.set(el, {
      headers: evaluate(expression || '{}')
    })
  })

  Alpine.addInitSelector(() => `[${Alpine.prefixed('merge')}]`)
  Alpine.directive('merge', (el, { modifiers, expression }) => {
    AjaxAttributes.set(el, {
      strategy: expression,
      transition: settings.transitions || modifiers.includes('transition')
    })
  })

  Alpine.magic('ajax', (el) => {
    return async (action, options = {}) => {
      let targets = findTargets(parseTargetIds(el, options.targets || options.target))
      targets = options.sync ? addSyncTargets(targets) : targets
      let referrer = source(el)
      let headers = Object.assign({}, AjaxAttributes.get(el, 'headers', {}), options.headers)
      let method = options.method ? options.method.toUpperCase() : 'GET'
      let body = options.body
      let enctype = options.enctype || 'application/x-www-form-urlencoded'

      let response = await request(el, targets, action, referrer, headers, method, body, enctype)

      let history = options.history || AjaxAttributes.get(el, 'history')
      let focus = ('focus' in options) ? options.focus : AjaxAttributes.get(el, 'focus', true)

      return render(response, el, targets, history, focus)
    }
  })
}

Ajax.configure = (options) => {
  settings = Object.assign(settings, options)

  return Ajax
}

export default Ajax

let AjaxAttributes = {
  store: new WeakMap,
  set(el, config) {
    if (this.store.has(el)) {
      this.store.set(el, Object.assign(this.store.get(el), config))
    } else {
      this.store.set(el, config)
    }
  },
  get(el, key, fallback = null) {
    let config = this.store.get(el) || {}

    return (key in config) ? config[key] : fallback
  }
}

addGlobalListener('click', async (event) => {
  if (event.defaultPrevented ||
    event.which > 1 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) return

  let link = event?.target.closest('a[href]:not([download]):not([noajax])')

  if (!link ||
    link.isContentEditable ||
    link.getAttribute('href').startsWith('#') ||
    link.origin !== location.origin ||
    ((link.pathname + link.search) === (location.pathname + location.search) && link.hash)
  ) return

  event.preventDefault()
  event.stopImmediatePropagation()

  let targets = findTargets(AjaxAttributes.get(link, 'targets', []))
  if (targets.length) {
    targets = addSyncTargets(targets)
  }
  let referrer = source(link)
  let action = link.getAttribute('href') || referrer
  let headers = AjaxAttributes.get(link, 'headers', {})
  let cacheKey = ResponseCache.key(action)
  if (ResponseCache.has(cacheKey)) {
    // console.log('preview', ResponseCache.get(cacheKey))
    render(ResponseCache.get(cacheKey), link, targets, false, true)
  }

  let response = await request(link, targets, action, referrer, headers)

  let history = AjaxAttributes.get(link, 'history')
  let focus = AjaxAttributes.get(link, 'focus', true)

  try {
    return await render(response, link, targets, history, focus)
  } catch (error) {
    if (error.name === 'RenderError') {
      console.warn(error.message)
      window.location.href = link.href
      return
    }

    throw error
  }
})

addGlobalListener('submit', async (event) => {
  if (event.defaultPrevented) {
    return
  }

  let form = event.target
  let submitter = event.submitter
  let method = (submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase()

  if (!form ||
    method === 'DIALOG' ||
    submitter?.hasAttribute('formnoajax') ||
    submitter?.hasAttribute('formtarget') ||
    form.hasAttribute('noajax') ||
    form.hasAttribute('target')
  ) return

  event.preventDefault()
  event.stopImmediatePropagation()

  let referrer = source(form)
  let action = form.getAttribute('action') || referrer
  let headers = AjaxAttributes.get(form, 'headers', {})
  let body = new FormData(form)
  let enctype = form.getAttribute('enctype') || 'application/x-www-form-urlencoded'
  if (submitter) {
    enctype = submitter.getAttribute('formenctype') || enctype
    action = submitter.getAttribute('formaction') || action
    if (submitter.name) {
      body.append(submitter.name, submitter.value)
    }
  }

  let targets = findTargets(AjaxAttributes.get(form, 'targets', []))
  if (targets.length) {
    targets = addSyncTargets(targets)
  }
  let response = await withSubmitter(submitter, () => {
    return request(form, targets, action, referrer, headers, method, body, enctype)
  })

  let history = AjaxAttributes.get(form, 'history')
  let focus = AjaxAttributes.get(form, 'focus', true)

  try {
    return await render(response, form, targets, history, focus)
  } catch (error) {
    if (error.name === 'RenderError') {
      console.warn(error.message)
      form.setAttribute('noajax', 'true')
      form.requestSubmit(submitter)

      return
    }

    throw error
  }
})

function addGlobalListener(name, callback) {
  let callbackWithErrorHandler = async (event) => {
    try {
      await callback(event)
    } catch (error) {
      if (error.name === 'AbortError') {
        return
      }

      throw error
    }
  }

  // Late bind listeners so they're last in the event chain
  let onCapture = () => {
    document.removeEventListener(name, callbackWithErrorHandler, false)
    document.addEventListener(name, callbackWithErrorHandler, false)
  }

  document.addEventListener(name, onCapture, true)
}

async function withSubmitter(submitter, callback) {
  if (!submitter) return await callback()

  let disableEvent = e => e.preventDefault()

  submitter.setAttribute('aria-disabled', 'true')
  submitter.addEventListener('click', disableEvent)

  let result = await callback()

  submitter.removeAttribute('aria-disabled')
  submitter.removeEventListener('click', disableEvent)

  return result
}

let PendingTargets = {
  store: new Map,
  abort(id) {
    if (this.store.has(id)) {
      let thing = this.store.get(id)
      thing.controller.abort()
      thing.target.removeAttribute('aria-busy')
    } else {
      // console.log('miss', id)
    }
  },
  set(id, target, controller) {
    this.abort(id)
    target.querySelectorAll('[aria-busy]').forEach((busy) => this.abort(busy.getAttribute('id')))
    this.store.set(id, { target, controller })
    target.setAttribute('aria-busy', 'true')
  },
}

let ResponseCache = {
  store: new Map,
  limit: 10,

  key(url) {
    return url.split('#')[0]
  },

  has(key) {
    return this.store.has(key)
  },

  get(key) {
    return this.store.get(key)
  },

  set(key, response) {
    this.trim()
    this.store.set(key, response)
  },

  trim() {
    while (this.store.size >= this.limit) {
      let oldestKey = this.store.keys().next().value
      this.store.delete(oldestKey)
    }
  }
}

async function request(el, targets, action, referrer, headers, method = 'GET', body = null, enctype = 'application/x-www-form-urlencoded') {
  if (!dispatch(el, 'ajax:before')) {
    throw new DOMException('[ajax:before] aborted', 'AbortError')
  }

  let controller = new AbortController()
  let targetIds = []
  if (targets.length) {
    targets.forEach(target => {
      let id = target.getAttribute('id')
      PendingTargets.set(id, target, controller)
      targetIds.push(id)
    })
  } else {
    PendingTargets.set('__ajax__', document.body, controller)
  }
  headers['X-Alpine-Target'] = targetIds.join('  ')
  headers['X-Alpine-Request'] = 'true'
  headers = Object.assign({}, settings.headers, headers)

  if (body) {
    body = parseFormData(body)
    if (method === 'GET') {
      action = mergeBodyIntoAction(body, action)
      body = null
    } else if (enctype !== 'multipart/form-data') {
      body = formDataToParams(body)
    }
  }

  let response = await fetch(action, {
    method,
    headers,
    body,
    referrer,
    signal: controller.signal
  })
  response.html = await response.text()

  // todo: Bust cache for redirected responses
  if (method === 'GET') {
    let cacheKey = ResponseCache.key(action)
    ResponseCache.set(cacheKey, response)
  }

  if (response.ok) {
    dispatch(el, 'ajax:success', response)
  } else {
    dispatch(el, 'ajax:error', response)
  }

  dispatch(el, 'ajax:after', response)

  return response
}

function parseFormData(data) {
  if (data instanceof FormData) return data
  if (data instanceof HTMLFormElement) return new FormData(data)

  const formData = new FormData()
  for (let key in data) {
    if (typeof data[key] === 'object') {
      formData.append(key, JSON.stringify(data[key]))
    } else {
      formData.append(key, data[key])
    }
  }

  return formData
}

function mergeBodyIntoAction(body, action) {
  let params = formDataToParams(body)

  if (Array.from(params).length) {
    let parts = action.split('#')
    let hash = parts[1]
    action += parts[0].includes('?') ? '&' : '?'
    action += params
    if (hash) {
      action += '#' + hash
    }

  }

  return action
}

function formDataToParams(body) {
  let params = Array.from(body.entries()).filter(([key, value]) => {
    return !(value instanceof File)
  })

  return new URLSearchParams(params)
}

async function render(response, el, targets, history, focus) {
  if (!response.html) {
    targets.forEach(target => target.removeAttribute('aria-busy'))

    return
  }

  if (targets.length === 0) {
    // console.log('render', el.href)
    updateHistory('push', response.url)
    let doc = new DOMParser().parseFromString(response.html, 'text/html')
    let body = document.adoptNode(doc.body)
    body.querySelectorAll('script').forEach(inert => {
      inert.replaceWith(cloneScriptTag(inert))
    })
    mergeHead(doc.head)
    document.body.replaceWith(body)
    document.body.removeAttribute('aria-busy')

    return
  }

  if (history) {
    updateHistory(history, response.url)
  }

  let wrapper = document.createRange().createContextualFragment('<template>' + response.html + '</template>')
  let fragment = wrapper.firstElementChild.content
  let focused = !focus
  let renders = targets.map(async target => {
    let content = fragment.getElementById(target.getAttribute('id'))
    let strategy = AjaxAttributes.get(target, 'strategy', settings.mergeStrategy)
    if (!content) {
      if (!dispatch(el, 'ajax:missing', { target, response })) {
        return
      }

      if (response.ok) {
        return target.remove();
      }

      throw new RenderError(target, response.status)
    }

    let mergeContent = async () => {
      let merged = await merge(strategy, target, content)

      if (merged) {
        merged.dataset.source = response.url
        merged.removeAttribute('aria-busy')
        let focusables = ['[x-autofocus]', '[autofocus]']
        focusables.some(selector => {
          if (focused) return true
          if (merged.matches(selector)) {
            focused = focusOn(merged)
          }

          return focused || Array.from(merged.querySelectorAll(selector)).some(focusable => focusOn(focusable))
        })
      }

      dispatch(merged, 'ajax:merged')

      return merged
    }

    if (!dispatch(target, 'ajax:merge', { strategy, content, merge: mergeContent })) {
      return
    }

    return mergeContent()
  })

  return await Promise.all(renders)
}

async function merge(strategy, from, to) {
  let strategies = {
    before(from, to) {
      from.before(...to.childNodes)

      return from
    },
    replace(from, to) {
      from.replaceWith(to)

      return to
    },
    update(from, to) {
      from.replaceChildren(...to.childNodes)

      return from
    },
    prepend(from, to) {
      from.prepend(...to.childNodes)

      return from
    },
    append(from, to) {
      from.append(...to.childNodes)

      return from
    },
    after(from, to) {
      from.after(...to.childNodes)

      return from
    },
    morph(from, to) {
      doMorph(from, to)

      return document.getElementById(to.getAttribute('id'))
    }
  }

  if (!AjaxAttributes.get(from, 'transition', document.startViewTransition)) {
    return strategies[strategy](from, to)
  }

  let merged = null
  let transition = document.startViewTransition(() => {
    merged = strategies[strategy](from, to)
    return Promise.resolve()
  })
  await transition.updateCallbackDone

  return merged
}

function focusOn(el) {
  if (!el) return false
  if (!el.getClientRects().length) return false
  setTimeout(() => {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0')
    el.focus()
  }, 0)

  return true
}

function updateHistory(strategy, url) {
  let strategies = {
    push: () => window.history.pushState({ __AJAX__: true }, '', url),
    replace: () => window.history.replaceState({ __AJAX__: true }, '', url),
  }

  return strategies[strategy]();
}

function parseTargetIds(el, target = null) {
  let ids = [el.getAttribute('id')]
  if (target) {
    ids = Array.isArray(target) ? target : target.split(' ')
  }
  ids = ids.filter(id => id)

  if (ids.length === 0) {
    throw new IDError(el)
  }

  return ids
}

function findTargets(ids = []) {
  return ids.map(id => {
    let target = document.getElementById(id)
    if (!target) {
      throw new TargetError(id)
    }

    return target
  })
}

function addSyncTargets(targets) {
  document.querySelectorAll('[x-sync]').forEach(el => {
    let id = el.getAttribute('id')
    if (!id) {
      throw new IdNotFoundError(el)
    }

    if (!targets.some(target => target.getAttribute('id') === id)) {
      targets.push(el)
    }
  })

  return targets
}

function source(el) {
  return el.closest('[data-source]')?.dataset.source || window.location.href
}

function mergeHead(newHeadTag) {
  if (!newHeadTag) return

  let added = []
  let removed = []
  let preserved = []
  let nodesToAppend = []

  let currentHead = document.head;

  // put all new head elements into a Map, by their outerHTML
  let srcToNewHeadNodes = new Map();
  for (const newHeadChild of newHeadTag.children) {
    srcToNewHeadNodes.set(newHeadChild.outerHTML, newHeadChild);
  }

  // get the current head
  for (const currentHeadElt of currentHead.children) {

    // If the current head element is in the map
    let inNewContent = srcToNewHeadNodes.has(currentHeadElt.outerHTML);
    let isReAppended = currentHeadElt.getAttribute("hx-head") === "re-eval";
    let isPreserved = false // api.getAttributeValue(currentHeadElt, "hx-preserve") === "true";
    if (inNewContent || isPreserved) {
      if (isReAppended) {
        // remove the current version and let the new version replace it and re-execute
        removed.push(currentHeadElt);
      } else {
        // this element already exists and should not be re-appended, so remove it from
        // the new content map, preserving it in the DOM
        srcToNewHeadNodes.delete(currentHeadElt.outerHTML);
        preserved.push(currentHeadElt);
      }
    } else {
      // if this is a merge, we remove this content since it is not in the new head
      removed.push(currentHeadElt);
    }
  }

  // Push the remaining new head elements in the Map into the
  // nodes to append to the head tag
  nodesToAppend.push(...srcToNewHeadNodes.values());
  // console.log("to append: ", nodesToAppend);

  for (const newNode of nodesToAppend) {
    // console.log("adding: ", newNode);
    let newElt = document.createRange().createContextualFragment(newNode.outerHTML);
    // console.log(newElt);
    currentHead.appendChild(newElt);
    added.push(newElt);
  }

  // remove all removed elements, after we have appended the new elements to avoid
  // additional network requests for things like style sheets
  for (const removedElement of removed) {
    currentHead.removeChild(removedElement);
  }
}

function cloneScriptTag(el) {
  let script = document.createElement('script')

  for (let attr of el.attributes) {
    script.setAttribute(attr.name, attr.value)
  }

  script.textContent = el.textContent
  script.async = el.async

  return script
}

function dispatch(el, name, detail) {
  return el.dispatchEvent(
    new CustomEvent(name, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    })
  )
}

class IDError extends DOMException {
  constructor(el) {
    let description = (el.outerHTML.match(/<[^>]+>/) ?? [])[0] ?? '[Element]'
    super(`${description} is missing an ID to target.`, 'IDError')
  }
}

class TargetError extends DOMException {
  constructor(id) {
    super(`[#${id}] was not found in the current document.`, 'TargetError')
  }
}

class RenderError extends DOMException {
  constructor(target, status) {
    let id = target.getAttribute('id')
    super(`Target [#${id}] was not found in response with status [${status}].`, 'RenderError')
  }
}
