/**
 * 中文 / 私有档位名 → magpie 规范名（`openAiEfforts`）。
 *
 * ## 为什么要有这条
 *
 * 上游 `effortView` 只认英文 id。豆包（doubao）的适配器声明的是
 * `{ id: '3', name: '低' }` 这种「数字 id + 中文名」，原样喂进去得到
 * `openai_efforts: []` —— 于是模型列表右侧既没有思考档位下拉、也没有
 * `variants`，而那个模型**其实能调档位**（上游请求体里就有
 * `reasoning_effort: '4'`）。2026-11-25 真机发现。
 *
 * 用法：node tests/t-reasoning-cn.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { openAiEfforts } = await import(pathToFileURL(path.join(ROOT, 'src', 'llm-bridge.mjs')).href)

let total = 0
let failed = 0

function ok(cond, label, extra) {
  total++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed++
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('· 1  豆包形态（数字 id + 中文名）')
{
  const got = openAiEfforts({
    reasoning: {
      efforts: [
        { id: '3', name: '低' },
        { id: '4', name: '中' },
        { id: '5', name: '高' },
        { id: '6', name: '极高' },
        { id: '7', name: '最高' },
      ],
      defaultEffort: '4',
    },
  })
  ok(eq(got, ['low', 'medium', 'high', 'xhigh', 'max']),
    '五个中文档位全部翻成规范名', JSON.stringify(got))
  ok(got.length === 5, '一个都不少（早先是空表）', `实际 ${got.length}`)
}

console.log('· 2  英文 id 原样不动（别家渠道不能被带歪）')
{
  const got = openAiEfforts({
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
  })
  ok(eq(got, ['low', 'high']), 'trae 那种英文 id 原样', JSON.stringify(got))
}

console.log('· 3  off / on（CodeArts 那类）仍然翻成 none / 规范名')
{
  const got = openAiEfforts({
    reasoning: { efforts: [{ id: 'off', name: '关闭' }, { id: 'on', name: '开启' }] },
  })
  ok(got.includes('none'), '关闭 → none', JSON.stringify(got))
  ok(got.length >= 1, '至少有一个可选项', JSON.stringify(got))
}

console.log('· 4  没声明档位时返回空数组（不是 undefined）')
{
  ok(eq(openAiEfforts({}), []), '空 info → 空数组')
  ok(eq(openAiEfforts({ reasoning: {} }), []), '有 reasoning 但没 efforts → 空数组')
  ok(eq(openAiEfforts({ reasoning: { efforts: [] } }), []), 'efforts 是空表 → 空数组')
}

console.log('· 5  名字认不出时不硬造（保住原始 id）')
{
  const got = openAiEfforts({ reasoning: { efforts: [{ id: '7', name: '某个没见过的中文档位' }] } })
  ok(eq(got, []), '认不出的名字不产生垃圾规范名', JSON.stringify(got))
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：中文档位名 → 规范名）`)
process.exit(failed === 0 ? 0 : 1)