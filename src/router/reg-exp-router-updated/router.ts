/* eslint-disable @typescript-eslint/ban-ts-comment */
import type { Router, Result } from '../../router'
import { METHOD_NAME_ALL, METHODS, UnsupportedPathError } from '../../router'
import { checkOptionalParameter } from '../../utils/url'
import { PATH_ERROR } from './node'
import type { ParamMap } from './trie'
import { Trie } from './trie'

const methodNames = [METHOD_NAME_ALL, ...METHODS].map((method) => method.toUpperCase())

type HandlerData<T> = [T[], ParamMap] | [Result<T>, null]
type StaticMap<T> = Map<string, Result<T>>
type Matcher<T> = [RegExp, HandlerData<T>[], StaticMap<T>]

const emptyParam = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nullMatcher: Matcher<any> = [/^$/, [], new Map<string, Result<any>>()]

const wildcardRegExpCache: Map<string, RegExp> = new Map<string, RegExp>()
function buildWildcardRegExp(path: string): RegExp {
  return wildcardRegExpCache.get(path) ?? wildcardRegExpCache.set(path, new RegExp(
    path === '*' ? '' : `^${path.replace(/\/\*/, '(?:|/.*)')}$`
  )).get(path)!
}

function buildMatcherFromPreprocessedRoutes<T>(routes: [string, T[]][]): Matcher<T> {
  const trie = new Trie()
  const handlers: HandlerData<T>[] = []
  if (routes.length === 0) {
    return nullMatcher
  }

  routes = routes.sort(([a], [b]) => a.length - b.length)

  const staticMap: StaticMap<T> = new Map<string, Result<T>>()
  for (let i = 0, j = -1, len = routes.length; i < len; i++) {
    const path = routes[i][0]
    let pathErrorCheckOnly = false
    if (!/\*|\/:/.test(path)) {
      pathErrorCheckOnly = true
      staticMap.set(routes[i][0], { handlers: routes[i][1], params: emptyParam })
    } else {
      j++
    }

    let paramMap
    try {
      paramMap = trie.insert(path, j, pathErrorCheckOnly)
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e
    }

    if (pathErrorCheckOnly) {
      continue
    }

    handlers[j] =
      paramMap.length === 0
        ? [{ handlers: routes[i][1], params: emptyParam }, null]
        : [routes[i][1], paramMap]
  }

  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp()
  for (let i = 0, len = handlers.length; i < len; i++) {
    const paramMap = handlers[i][1]
    if (paramMap) {
      for (let j = 0, len = paramMap.length; j < len; j++) {
        paramMap[j][1] = paramReplacementMap[paramMap[j][1]]
      }
    }
  }

  const handlerMap: HandlerData<T>[] = []
  // using `in` because indexReplacementMap is a sparse array
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlers[indexReplacementMap[i]]
  }
  return [regexp, handlerMap, staticMap] as Matcher<T>
}

function findMiddleware<T>(
  middleware: Map<string, T[]> | undefined,
  path: string
): T[] | undefined {
  if (!middleware) {
    return undefined
  }

  for (const k of [...middleware.keys()].sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware.get(k) as T[]]
    }
  }

  return undefined
}

export class RegExpRouterUpdated<T> implements Router<T> {
  middleware?: Map<string, Map<string, T[]>>
  routes?: Map<string, Map<string, T[]>>
  matchers?: Map<string, Matcher<T>>

  constructor() {
    this.middleware = new Map([[METHOD_NAME_ALL, new Map()]])
    this.routes = new Map([[METHOD_NAME_ALL, new Map()]])
  }

  add(method: string, path: string, handler: T) {
    const { middleware, routes } = this

    if (!middleware || !routes) {
      throw new Error('Can not add a route since the matcher is already built.')
    }

    if (!methodNames.includes(method)) methodNames.push(method)
    if (!middleware.has(method)) {
      ;[middleware, routes].forEach((handlerMap) => {
        const methodMap = new Map()
        const allMap = handlerMap.get(METHOD_NAME_ALL)!
        handlerMap.set(method, methodMap)
        for (const p of allMap.keys()) {
          methodMap.set(p, [...allMap.get(p)!])
        }
      })
    }

    if (path === '/*') {
      path = '*'
    }

    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path)
      if (method === METHOD_NAME_ALL) {
        middleware.forEach((middlewareMap, m) => {
          middlewareMap.set(
            path,
            middlewareMap.get(path) ||
              findMiddleware(middlewareMap, path) ||
              findMiddleware(middleware.get(METHOD_NAME_ALL), path) ||
              []
          )
          middlewareMap.forEach((handlers, p) => {
            re.test(p) && handlers.push(handler)
          })
        })
        routes.forEach((routeMap, m) => {
          routeMap.forEach((handlers, p) => {
            re.test(p) && handlers.push(handler)
          })
        })
      } else {
        const methodMiddleware = middleware.get(method)!
        methodMiddleware.set(
          path,
          methodMiddleware.get(path) ||
            findMiddleware(methodMiddleware, path) ||
            findMiddleware(middleware.get(METHOD_NAME_ALL), path) ||
            []
        )
        methodMiddleware.forEach((handlers, p) => {
          re.test(p) && handlers.push(handler)
        })
        routes.get(method)!.forEach((handlers, p) => {
          re.test(p) && handlers.push(handler)
        })
      }
      return
    }

    const paths = checkOptionalParameter(path) || [path]
    for (let i = 0, len = paths.length; i < len; i++) {
      const path = paths[i]

      Array.from(routes.keys()).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          if (!routes.get(m)!.get(path)) {
            routes.get(m)!.set(path, [
              ...(findMiddleware(middleware.get(m), path) ||
                findMiddleware(middleware.get(METHOD_NAME_ALL), path) ||
                []),
            ]);
          }
          routes.get(m)!.get(path)!.push(handler);
        }
      });
    }
  }

  freeze() {
    wildcardRegExpCache.clear() // TODO: remove from hot path
    this.matchers = this.buildAllMatchers() // TODO: this also clears some cache, should be removed from hot path
  }
  
  match(method: string, path: string): Result<T> | null {
      const matcher = this.matchers?.get(method)!

      const staticMatch = matcher[2].get(path)
      if (staticMatch) {
        return staticMatch
      }

      const match = path.match(matcher[0])
      if (!match) {
        return null
      }

      const index = match.indexOf('', 1)
      const [handlers, paramMap] = matcher[1][index]
      if (!paramMap) {
        return handlers
      }

      const params: Record<string, string> = {}
      for (let i = 0, len = paramMap.length; i < len; i++) {
        params[paramMap[i][0]] = match[paramMap[i][1]]
      }

      return { handlers, params }
  }

  private buildAllMatchers(): Map<string, Matcher<T>> {
    const matchers: Map<string, Matcher<T>> = new Map()
    methodNames.forEach((method) => {
      matchers.set(method, this.buildMatcher(method) || matchers.get(METHOD_NAME_ALL)!)
    })

    // Release cache
    this.middleware = this.routes = undefined

    return matchers
  }

  private buildMatcher(method: string): Matcher<T> | null {
    const routes: [string, T[]][] = []

    let hasOwnRoute = method === METHOD_NAME_ALL
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ;[this.middleware!, this.routes!].forEach((r: Map<string, Map<string, T[]>>) => {
      const ownRoute = r.get(method)
        ? Array.from(r.get(method)!.entries())
        : []
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true
        routes.push(...ownRoute)
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Array.from(r.get(METHOD_NAME_ALL)!.entries())
        )
      }
    })

    if (!hasOwnRoute) {
      return null
    } else {
      return buildMatcherFromPreprocessedRoutes(routes)
    }
  }
}
