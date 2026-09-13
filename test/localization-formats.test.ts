import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseLocalizationDocument,
  serializeLocalizationDocument,
  type LocalizationDocumentEntry,
} from '../src/index.ts'

const entries: LocalizationDocumentEntry[] = [
  {
    key: 'home.greeting',
    values: { en: 'Hello, {name}!', tr: 'Merhaba, {name}!' },
    description: 'Landing page greeting',
    context: 'Top of the signed-in home screen',
    characterLimit: 40,
  },
  { key: 'home.title', values: { en: 'Welcome', tr: 'Hoş geldiniz' } },
]

test('nested and flat JSON round-trip locale values', () => {
  const nested = serializeLocalizationDocument({
    format: 'nested_json',
    locale: 'tr',
    locales: ['en', 'tr'],
    entries,
  })
  assert.equal(nested.extension, 'json')
  assert.deepEqual(JSON.parse(nested.content), {
    home: { greeting: 'Merhaba, {name}!', title: 'Hoş geldiniz' },
  })
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'nested_json',
      content: nested.content,
      locale: 'tr',
      allowedLocales: ['en', 'tr'],
    }),
    [
      { key: 'home.greeting', locale: 'tr', value: 'Merhaba, {name}!' },
      { key: 'home.title', locale: 'tr', value: 'Hoş geldiniz' },
    ],
  )

  const flat = serializeLocalizationDocument({
    format: 'flat_json',
    locale: 'en',
    locales: ['en', 'tr'],
    entries,
  })
  assert.deepEqual(JSON.parse(flat.content), {
    'home.greeting': 'Hello, {name}!',
    'home.title': 'Welcome',
  })
})

test('ARB preserves LinguaFlow metadata and locale', () => {
  const arb = serializeLocalizationDocument({
    format: 'arb',
    locale: 'en',
    locales: ['en', 'tr'],
    entries,
  })
  assert.deepEqual(JSON.parse(arb.content)['@home.greeting'], {
    description: 'Landing page greeting',
    'x-linguaflow-context': 'Top of the signed-in home screen',
    'x-linguaflow-character-limit': 40,
  })
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'arb',
      content: arb.content,
      locale: 'tr',
      allowedLocales: ['en', 'tr'],
    })[0],
    {
      key: 'home.greeting',
      locale: 'en',
      value: 'Hello, {name}!',
      description: 'Landing page greeting',
      context: 'Top of the signed-in home screen',
      characterLimit: 40,
    },
  )
})

test('CSV round-trips all locales, commas, quotes and newlines', () => {
  const csv = serializeLocalizationDocument({
    format: 'csv',
    locales: ['en', 'tr'],
    entries: [
      {
        key: 'legal.notice',
        values: { en: 'Read, "accept"\nand continue', tr: 'Oku ve devam et' },
        description: 'Legal, multiline',
      },
    ],
  })
  const parsed = parseLocalizationDocument({
    format: 'csv',
    content: csv.content,
    allowedLocales: ['en', 'tr'],
  })
  assert.deepEqual(parsed, [
    {
      key: 'legal.notice',
      locale: 'en',
      value: 'Read, "accept"\nand continue',
      description: 'Legal, multiline',
      context: undefined,
      characterLimit: undefined,
    },
    {
      key: 'legal.notice',
      locale: 'tr',
      value: 'Oku ve devam et',
      description: 'Legal, multiline',
      context: undefined,
      characterLimit: undefined,
    },
  ])
})

test('YAML 1.2 nested maps round-trip and aliases are rejected', () => {
  const yaml = serializeLocalizationDocument({
    format: 'yaml',
    locale: 'tr',
    locales: ['en', 'tr'],
    entries,
  })
  assert.equal(yaml.extension, 'yaml')
  assert.match(yaml.content, /home:/)
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'yaml',
      content: yaml.content,
      locale: 'tr',
      allowedLocales: ['en', 'tr'],
    }).map(({ key, value }) => ({ key, value })),
    [
      { key: 'home.greeting', value: 'Merhaba, {name}!' },
      { key: 'home.title', value: 'Hoş geldiniz' },
    ],
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'yaml',
        content: 'shared: &copy Hello\nhome:\n  title: *copy\n',
        locale: 'en',
        allowedLocales: ['en'],
      }),
    /valid YAML/,
  )
})

test('Android XML uses reversible resource names and rejects DOCTYPE', () => {
  const android = serializeLocalizationDocument({
    format: 'android_xml',
    locale: 'tr',
    locales: ['en', 'tr'],
    entries,
  })
  assert.equal(android.extension, 'xml')
  assert.match(android.content, /name="home__greeting"/)
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'android_xml',
      content: android.content,
      locale: 'tr',
      allowedLocales: ['tr'],
    }).map(({ key, value }) => ({ key, value })),
    [
      { key: 'home.greeting', value: 'Merhaba, {name}!' },
      { key: 'home.title', value: 'Hoş geldiniz' },
    ],
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'android_xml',
        content: '<!DOCTYPE resources><resources/>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /DOCTYPE/,
  )
})

test('Android XML escapes reserved characters without changing the value', () => {
  const document = serializeLocalizationDocument({
    format: 'android_xml',
    locale: 'en',
    locales: ['en'],
    entries: [{ key: 'legal.notice', values: { en: 'Use A & B < C' } }],
  })
  const imported = parseLocalizationDocument({
    format: 'android_xml',
    content: document.content,
    locale: 'en',
    allowedLocales: ['en'],
  })
  assert.equal(imported[0]?.value, 'Use A & B < C')
})

test('Apple Strings quotes and multiline values round-trip', () => {
  const source = [{ key: 'legal.notice', values: { tr: '“Oku”\nve devam et \\' } }]
  const document = serializeLocalizationDocument({
    format: 'apple_strings',
    locale: 'tr',
    locales: ['tr'],
    entries: source,
  })
  assert.equal(document.extension, 'strings')
  assert.equal(
    parseLocalizationDocument({
      format: 'apple_strings',
      content: document.content,
      locale: 'tr',
      allowedLocales: ['tr'],
    })[0]?.value,
    '“Oku”\nve devam et \\',
  )
})

test('Apple Strings keeps comment markers inside quoted values', () => {
  const imported = parseLocalizationDocument({
    format: 'apple_strings',
    content: '/* note */\n"legal.notice" = "Use /* literally */ and // too";\n',
    locale: 'en',
    allowedLocales: ['en'],
  })
  assert.equal(imported[0]?.value, 'Use /* literally */ and // too')
})

test('Apple String Catalog round-trips all locales and workflow status', () => {
  const catalog = serializeLocalizationDocument({
    format: 'string_catalog',
    sourceLocale: 'en',
    locales: ['en', 'tr'],
    entries: [{ ...entries[0]!, statuses: { tr: 'in_review' } }],
  })
  assert.equal(catalog.extension, 'xcstrings')
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'string_catalog',
      content: catalog.content,
      sourceLocale: 'en',
      allowedLocales: ['en', 'tr'],
    }),
    [
      {
        key: 'home.greeting',
        locale: 'en',
        value: 'Hello, {name}!',
        status: 'translated',
        description: 'Landing page greeting',
      },
      {
        key: 'home.greeting',
        locale: 'tr',
        value: 'Merhaba, {name}!',
        status: 'in_review',
        description: 'Landing page greeting',
      },
    ],
  )
})

test('GNU PO preserves key context, metadata, ICU and workflow state', () => {
  const po = serializeLocalizationDocument({
    format: 'po',
    locale: 'tr',
    sourceLocale: 'en',
    locales: ['en', 'tr'],
    entries: [{ ...entries[0]!, statuses: { tr: 'approved' } }],
  })
  assert.equal(po.extension, 'po')
  assert.match(po.content, /msgctxt "home.greeting"/)
  assert.match(po.content, /linguaflow-status-approved/)
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'po',
      content: po.content,
      locale: 'tr',
      sourceLocale: 'en',
      allowedLocales: ['en', 'tr'],
    }),
    [
      {
        key: 'home.greeting',
        locale: 'tr',
        value: 'Merhaba, {name}!',
        status: 'approved',
        description: 'Landing page greeting',
        context: 'Top of the signed-in home screen',
        characterLimit: 40,
      },
    ],
  )
})

test('GNU PO plural forms become portable ICU categories', () => {
  const po = `msgid ""\nmsgstr ""\n"Language: ru\\n"\n"Plural-Forms: nplurals=3; plural=0;\\n"\n\nmsgctxt "cart.items"\nmsgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] "%d товар"\nmsgstr[1] "%d товара"\nmsgstr[2] "%d товаров"\n`
  const parsed = parseLocalizationDocument({
    format: 'po',
    content: po,
    allowedLocales: ['ru'],
  })
  assert.equal(
    parsed[0]?.value,
    '{count, plural, one {# товар} few {# товара} many {# товаров} other {# товаров}}',
  )
})

test('GNU PO rejects unknown plural mappings instead of changing their meaning', () => {
  const po = `msgid ""\nmsgstr ""\n"Language: zz\\n"\n"Plural-Forms: nplurals=3; plural=0;\\n"\n\nmsgctxt "cart.items"\nmsgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] "first"\nmsgstr[1] "second"\nmsgstr[2] "third"\n`
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'po',
        content: po,
        allowedLocales: ['zz'],
      }),
    /plural mapping.*not supported/,
  )
})

test('XLIFF 2.1 round-trips status, notes, limits and escaped ICU', () => {
  const document = serializeLocalizationDocument({
    format: 'xliff',
    locale: 'tr',
    sourceLocale: 'en',
    locales: ['en', 'tr'],
    entries: [{ ...entries[0]!, statuses: { tr: 'in_review' } }],
  })
  assert.equal(document.extension, 'xlf')
  assert.match(document.content, /version="2.1"/)
  assert.match(document.content, /slr:sizeRestriction="40"/)
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'xliff',
      content: document.content,
      locale: 'tr',
      allowedLocales: ['en', 'tr'],
    }),
    [
      {
        key: 'home.greeting',
        locale: 'tr',
        value: 'Merhaba, {name}!',
        status: 'in_review',
        description: 'Landing page greeting',
        context: 'Top of the signed-in home screen',
        characterLimit: 40,
      },
    ],
  )
})

test('XLIFF supports 1.2 inline placeholders and 2.x segmentation', () => {
  const xliff12 = `<?xml version="1.0"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en" target-language="tr"><body><trans-unit id="1" resname="home.greeting" approved="yes"><source>Hello <ph id="1" equiv-text="{name}"/></source><target>Merhaba <ph id="1" equiv-text="{name}"/>!</target><note>Greeting</note></trans-unit></body></file></xliff>`
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'xliff',
      content: xliff12,
      allowedLocales: ['en', 'tr'],
    })[0],
    {
      key: 'home.greeting',
      locale: 'tr',
      value: 'Merhaba {name}!',
      status: 'approved',
      description: 'Greeting',
      context: undefined,
      characterLimit: undefined,
    },
  )

  const segmented = `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="en" trgLang="tr"><file id="f"><unit id="legal.notice"><segment state="translated"><source>A</source><target>Birinci. </target></segment><ignorable><source> </source><target> </target></ignorable><segment state="reviewed"><source>B</source><target>İkinci.</target></segment></unit></file></xliff>`
  assert.deepEqual(
    parseLocalizationDocument({
      format: 'xliff',
      content: segmented,
      locale: 'tr',
      allowedLocales: ['tr'],
    })[0],
    {
      key: 'legal.notice',
      locale: 'tr',
      value: 'Birinci.  İkinci.',
      status: 'translated',
      description: undefined,
      context: undefined,
      characterLimit: undefined,
    },
  )
})

test('XLIFF restores paired codes from originalData', () => {
  const content = `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="en" trgLang="tr"><file id="f"><unit id="rich.link"><originalData><data id="open">&lt;b&gt;</data><data id="close">&lt;/b&gt;</data></originalData><segment state="translated"><source>Bold</source><target><pc id="1" dataRefStart="open" dataRefEnd="close">Kalın</pc></target></segment></unit></file></xliff>`
  assert.equal(
    parseLocalizationDocument({
      format: 'xliff',
      content,
      locale: 'tr',
      sourceLocale: 'en',
      allowedLocales: ['en', 'tr'],
    })[0]?.value,
    '<b>Kalın</b>',
  )
})

test('XLIFF rejects entities, unsupported versions and locale mismatches', () => {
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'xliff',
        content: '<!DOCTYPE xliff [<!ENTITY x "boom">]><xliff version="2.1"/>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /entities are not allowed/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'xliff',
        content: '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.0" version="1.0"/>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /Unsupported XLIFF version/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'xliff',
        content:
          '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="en" trgLang="de"><file id="f"/></xliff>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /does not match requested locale/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'xliff',
        content:
          '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.1" srcLang="en"><file id="f"><unit id="home.title"><segment><source>Hello</source><target>Merhaba</target></segment></unit></file></xliff>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /target locale is missing/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'xliff',
        content: '<xliff xmlns="urn:example:wrong" version="2.1" srcLang="en"/>',
        locale: 'tr',
        allowedLocales: ['tr'],
      }),
    /namespace must be/,
  )
})

test('imports reject unsafe shapes, keys, locales and malformed CSV', () => {
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'nested_json',
        content: '{"Home":{"title":"No"}}',
        locale: 'en',
        allowedLocales: ['en'],
      }),
    /Invalid localization key/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'flat_json',
        content: '{"home.title":"Hello"}',
        locale: 'de',
        allowedLocales: ['en'],
      }),
    /not enabled/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'csv',
        content: 'key,en\r\nhome.title,"unterminated',
        allowedLocales: ['en'],
      }),
    /unclosed quoted field/,
  )
  assert.throws(
    () =>
      serializeLocalizationDocument({
        format: 'nested_json',
        locale: 'en',
        locales: ['en'],
        entries: [
          { key: 'home', values: { en: 'Home' } },
          { key: 'home.title', values: { en: 'Title' } },
        ],
      }),
    /cannot represent both/,
  )
  assert.throws(
    () =>
      parseLocalizationDocument({
        format: 'arb',
        content: JSON.stringify({
          '@@locale': 'en',
          'home.title': 'Hello',
          '@home.title': { description: 'x'.repeat(501) },
        }),
        locale: 'en',
        allowedLocales: ['en'],
      }),
    /Description.*exceeds 500/,
  )
})
