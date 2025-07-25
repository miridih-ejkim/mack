import {
  DividerBlock,
  HeaderBlock,
  ImageBlock,
  KnownBlock,
  SectionBlock,
} from '@slack/types';
import {ListOptions, ParsingOptions} from '../types';
import {section, divider, header, image} from '../slack';
import {marked} from 'marked';
import {XMLParser} from 'fast-xml-parser';

marked.setOptions({
  mangle: false,
  headerIds: false,
});

type PhrasingToken =
  | marked.Tokens.Link
  | marked.Tokens.Em
  | marked.Tokens.Strong
  | marked.Tokens.Del
  | marked.Tokens.Br
  | marked.Tokens.Image
  | marked.Tokens.Codespan
  | marked.Tokens.Text
  | marked.Tokens.HTML;


// HeaderBlock 전용: 모든 마크다운 서식을 제거하여 plain text 생성
function parseHeaderPlainText(element: PhrasingToken): string[] {
  switch (element.type) {
    case 'link': {
      // HeaderBlock에서는 "텍스트 (URL)" 형식으로 처리
      const linkText = element.tokens
        .flatMap(child => parseHeaderPlainText(child as PhrasingToken))
        .join('');
      return [`${linkText} (${element.href})`];
    }

    case 'em':
    case 'strong':
    case 'del':
      return element.tokens.flatMap(child =>
        parseHeaderPlainText(child as PhrasingToken)
      );

    case 'br':
      return [];

    case 'image':
      return [element.title ?? element.href];

    case 'codespan':
    case 'text':
    case 'html':
      // HeaderBlock용: 모든 마크다운 서식 제거
      return [element.raw
        .replace(/\*+/g, '')     // *굵게*, **굵게** 제거
        .replace(/_+/g, '')      // _기울임_ 제거
        .replace(/~+/g, '')      // ~취소선~ 제거
        .replace(/`+/g, '')      // `코드` 제거
      ];
  }
}

function isSectionBlock(block: KnownBlock): block is SectionBlock {
  return block.type === 'section';
}

function parseMrkdwn(
  element: Exclude<PhrasingToken, marked.Tokens.Image>
): string {
  switch (element.type) {
    case 'link': {
      return `<${element.href}|${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}>`;
    }

    case 'em': {
      return `_${element.text}_`;
    }

    case 'codespan':
      return `\`${element.text}\``;

    case 'strong': {
      return `*${element.text}*`;
    }

    case 'text':
    case 'html':
      return element.raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    case 'del': {
      return `~${element.text}~`;
    }

    default:
      return '';
  }
}

function addMrkdwn(
  content: string,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  const last = accumulator[accumulator.length - 1];

  if (last && isSectionBlock(last) && last.text) {
    last.text.text += content;
  } else {
    accumulator.push(section(content));
  }
}

function parsePhrasingContentToStrings(
  element: PhrasingToken,
  accumulator: string[]
) {
  if (element.type === 'image') {
    accumulator.push(element.href ?? element.title ?? element.text ?? 'image');
  } else {
    const text = parseMrkdwn(element);
    accumulator.push(text);
  }
}

function parsePhrasingContent(
  element: PhrasingToken,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  if (element.type === 'image') {
    const imageBlock: ImageBlock = image(
      element.href,
      element.text || element.title || element.href,
      element.title
    );
    accumulator.push(imageBlock);
  } else {
    const text = parseMrkdwn(element);
    addMrkdwn(text, accumulator);
  }
}

function parseParagraph(element: marked.Tokens.Paragraph): KnownBlock[] {
  // `**출처:**` 텍스트를 특별히 처리하여 divider와 함께 굵게 표시
  if (element.raw.trim() === '**출처:**') {
    return [divider(), section('*출처:*')];
  }

  // Paragraphs in Slack are just simple text, so we'll convert all phrasing
  // content to a single string and remove any problematic markdown like bold/italics.
  const text = element.tokens
    .map(token => {
      // For links, we preserve them. For everything else, we take the raw text
      // and strip any lingering markdown formatting characters.
      if (token.type === 'link') {
        return `<${token.href}|${token.text}>`;
      }
      return token.raw;
    })
    .join('')
    .replace(/[*_~]+/g, ''); // Remove bold, italic, strikethrough markers

  if (!text) {
    return [];
  }

  // Since we are creating a new section block from scratch, we can use the
  // simple section constructor.
  return [section(text)];
}

function hasNonAlphabetOrKorean(text: string): boolean {
  // 한글, 영문, 숫자, 공백, 기본 구두점을 제외한 모든 문자 체크
  const nonStandardRegex = /[^\u0020-\u007E\uAC00-\uD7AF\u3130-\u318F]/;
  return nonStandardRegex.test(text);
}

function parseHeading(element: marked.Tokens.Heading): KnownBlock[] {
  switch (element.depth) {
    // H1 (#) -> HeaderBlock 사용
    case 1: {
      // HeaderBlock은 plain_text만 지원하므로, parseHeaderPlainText를 사용해 서식을 제거합니다.
      const h1Text = element.tokens
        .flatMap(child => parseHeaderPlainText(child as PhrasingToken))
        .join('');

      if (hasNonAlphabetOrKorean(h1Text)) {
        return [header(h1Text)];
      } else {
        return [header('🔎 ' + h1Text)];
      }
    }

    // H2 (##) -> Divider + HeaderBlock 사용
    case 2: {
      // H2 텍스트를 mrkdwn으로 파싱하여 서식을 보존합니다.
      const h2Text = element.tokens
        .map(t => parseMrkdwn(t as Exclude<PhrasingToken, marked.Tokens.Image>))
        .join('');

      return [divider(), header(`${h2Text}`)];
    }
    
    // H3 (###) -> 인용(>) 스타일을 사용해 들여쓰기된 굵은 텍스트 SectionBlock
    case 3: {
      // 헤더 텍스트를 굵게 만들기 위해 직접 처리
      let h3Text = element.tokens
        .map(t => parseMrkdwn(t as Exclude<PhrasingToken, marked.Tokens.Image>))
        .join('');

      // 링크 포맷을 보호하면서 다른 *만 제거
      h3Text = h3Text.replace(/(?<!<[^>]*)\*(.*?)\*(?![^<]*>)/g, '$1');

      return [section(`› *${h3Text}*`)];
    }

    // H4 (####) 이하 -> 단순 들여쓰기 텍스트로 처리
    default: {
      let otherHeadingText = element.tokens
        .map(t => parseMrkdwn(t as Exclude<PhrasingToken, marked.Tokens.Image>))
        .join('');
      
      // 링크 포맷을 보호하면서 다른 *만 제거
      otherHeadingText = otherHeadingText.replace(/(?<!<[^>]*)\*(.*?)\*(?![^<]*>)/g, '$1');
      
      return [section(`› *${otherHeadingText}*`)];
    }
  }
}

function parseCode(element: marked.Tokens.Code): SectionBlock {
  return section(`\`\`\`\n${element.text}\n\`\`\``);
}

/**
 * 마크다운 리스트 토큰을 파싱하여 Slack의 SectionBlock으로 변환합니다.
 * 중첩 리스트, 코드 블록, 인용문 등 복잡한 콘텐츠를 재귀적으로 처리하도록 개선되었습니다.
 * @param element The marked.Tokens.List object.
 * @param options List-specific options from the parsing options.
 * @param depth The current nesting depth, used for correct indentation.
 * @returns A SectionBlock containing the fully formatted list.
 */
function parseList(
  element: marked.Tokens.List,
  options: ListOptions = {},
  depth = 0,
): SectionBlock {
  let listIndex = 0; // 순서 있는 리스트의 인덱스

  const contents = element.items.map((item: marked.Tokens.ListItem) => {
    // 각 리스트 아이템의 모든 토큰을 순회하며 텍스트 콘텐츠를 조합합니다.
    const itemBlocks: string[] = [];

    for (const token of item.tokens) {
      let blockContent = '';
      switch (token.type) {
        // 'text' 토큰은 사실상 'paragraph'와 같습니다.
        // 인라인 요소(bold, link 등)를 포함하고 있으므로 parseMrkdwn으로 처리합니다.
        case 'paragraph': {
          const paragraphBlocks = parseParagraph(token);
          const blockContent = paragraphBlocks
            .map(b => (b as SectionBlock).text?.text || '')
            .join('');
          
          if (blockContent) itemBlocks.push(blockContent);
          break;
        }

        case 'text': {
          const textToken = token as marked.Tokens.Text;
          const textBlocks: string[] = [];
          const textTokens = textToken.tokens ?? [textToken];

          for (const childToken of textTokens) {
            if (childToken.type !== 'image') {
              textBlocks.push(parseMrkdwn(childToken as Exclude<PhrasingToken, marked.Tokens.Image>));
            }
          }
          if (textBlocks.length > 0) {
            itemBlocks.push(textBlocks.join(''));
          }
          break;
        }
        
        // 중첩된 리스트 발견 시, 재귀적으로 parseList를 호출합니다.
        case 'list': {
          const nestedListBlock = parseList(token, options, depth + 1);
          // 재귀 호출 결과(SectionBlock)에서 텍스트만 추출하여 추가합니다.
          if (nestedListBlock.text?.text) itemBlocks.push(nestedListBlock.text.text);
          break;
        }
        
        // 기존 코드 블록 파서를 호출하고 결과 텍스트를 가져옵니다.
        case 'code': {
          const codeBlock = parseCode(token);
          if (codeBlock.text?.text) itemBlocks.push(codeBlock.text.text);
          break;
        }

        // 기존 인용문 파서를 호출하고 결과 텍스트를 조합합니다.
        case 'blockquote': {
          const bqBlocks = parseBlockquote(token);
          blockContent = bqBlocks
            .map(b => (b as SectionBlock).text?.text || '')
            .join('\n');
          if (blockContent) itemBlocks.push(blockContent);
          break;
        }

        // 리스트 아이템 사이의 공백은 줄바꿈으로 처리합니다.
        case 'space': {
          break;
        }
      }
    }
    
    // 최종적으로 조합된 콘텐츠에 리스트 서식(bullet, number)을 적용합니다.
    const indent = '  '.repeat(depth);
    const prefix = indent + (element.ordered ? `${++listIndex}. `: '• ');
    const itemContent = itemBlocks.join('\n');

    // 내용의 각 줄에 들여쓰기가 적용되도록 함
    const multiLinePrefix = prefix.replace(/./g, ' ');
    const indentedContent = itemContent.split('\n').join(`\n${multiLinePrefix}`);

    return `${prefix}${indentedContent}`;        
  });

  return section(contents.join('\n'));
}

function combineBetweenPipes(texts: String[]): string {
  return `| ${texts.join(' | ')} |`;
}

function parseTableRows(rows: marked.Tokens.TableCell[][]): string[] {
  const parsedRows: string[] = [];
  rows.forEach((row, index) => {
    const parsedCells = parseTableRow(row);
    if (index === 1) {
      const headerRowArray = new Array(parsedCells.length).fill('---');
      const headerRow = combineBetweenPipes(headerRowArray);
      parsedRows.push(headerRow);
    }
    parsedRows.push(combineBetweenPipes(parsedCells));
  });
  return parsedRows;
}

function parseTableRow(row: marked.Tokens.TableCell[]): String[] {
  const parsedCells: String[] = [];
  row.forEach(cell => {
    parsedCells.push(parseTableCell(cell));
  });
  return parsedCells;
}

function parseTableCell(cell: marked.Tokens.TableCell): String {
  const texts = cell.tokens.reduce((accumulator, child) => {
    parsePhrasingContentToStrings(child as PhrasingToken, accumulator);
    return accumulator;
  }, [] as string[]);
  return texts.join(' ');
}

function parseTable(element: marked.Tokens.Table): SectionBlock {
  const parsedRows = parseTableRows([element.header, ...element.rows]);

  return section(`\`\`\`\n${parsedRows.join('\n')}\n\`\`\``);
}

function parseBlockquote(element: marked.Tokens.Blockquote): KnownBlock[] {
  return element.tokens
    .filter(
      (child): child is marked.Tokens.Paragraph => child.type === 'paragraph'
    )
    .flatMap(p =>
      parseParagraph(p).map(block => {
        if (isSectionBlock(block) && block.text?.text?.includes('\n'))
          block.text.text = '> ' + block.text.text.replace(/\n/g, '\n> ');
        return block;
      })
    );
}

function parseThematicBreak(): KnownBlock[] {
  return [];
}

function parseHTML(
  element: marked.Tokens.HTML | marked.Tokens.Tag
): KnownBlock[] {
  const parser = new XMLParser({ignoreAttributes: false});
  const res = parser.parse(element.raw);

  if (res.img) {
    const tags = res.img instanceof Array ? res.img : [res.img];

    return tags
      .map((img: Record<string, string>) => {
        const url: string = img['@_src'];
        return image(url, img['@_alt'] || url);
      })
      .filter((e: Record<string, string>) => !!e);
  } else return [];
}

function parseToken(
  token: marked.Token,
  options: ParsingOptions
): KnownBlock[] {
  switch (token.type) {
    case 'heading':
      return parseHeading(token);

    case 'paragraph':
      return parseParagraph(token);

    case 'code':
      return [parseCode(token)];

    case 'blockquote':
      return parseBlockquote(token);

    case 'list':
      return [parseList(token, options.lists)];

    case 'table':
      return [parseTable(token)];

    case 'hr':
      return parseThematicBreak();

    case 'html':
      return parseHTML(token);

    default:
      return [];
  }
}

export function parseBlocks(
  tokens: marked.TokensList,
  options: ParsingOptions = {}
): KnownBlock[] {
  const resultBlocks: KnownBlock[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    // `**출처:**` 패턴을 일관되게 처리하는 단일 규칙
    if (
      token.type === 'paragraph' &&
      token.raw.trim() === '**출처:**'
    ) {
      // 1. `**출처:**`를 발견하면 무조건 H2 스타일(divider + header)을 적용합니다.
      resultBlocks.push(divider(), header('출처'));

      // 다음 토큰이 리스트인지 확인 (공백 토큰 건너뛰기)
      let nextTokenIndex = i + 1;
      if (tokens[nextTokenIndex]?.type === 'space') {
        nextTokenIndex++;
      }
      const nextToken = tokens[nextTokenIndex];

      // 만약 리스트가 뒤따라온다면, 기존 parseList를 사용해 처리
      if (nextToken?.type === 'list') {
        resultBlocks.push(parseList(nextToken, options.lists));
        // 처리된 토큰(출처, 공백, 리스트)을 모두 건너뛰기
        i = nextTokenIndex + 1;
        continue;
      }

      // `**출처:**` 토큰만 처리했으므로 다음 토큰으로 이동
      i++;
      continue;
    }

    // 4. `**출처:**`가 아닌 다른 모든 토큰은 기존 방식으로 처리합니다.
    resultBlocks.push(...parseToken(token, options));
    i++;
  }

  return resultBlocks;
}
