import {Box, Text, useStdout} from 'ink';
import {marked, type Token, type Tokens} from 'marked';
import stringWidth from 'string-width';
import {theme} from '../theme.js';
import {DEFAULT_TERMINAL_COLUMNS} from '../stream-view.js';

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function Inline({tokens}: {tokens: Token[]}) {
  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'strong':
            return (
              <Text key={i} bold color={theme.foreground}>
                <Inline tokens={(token as Tokens.Strong).tokens} />
              </Text>
            );
          case 'em':
            return (
              <Text key={i} italic color={theme.foreground}>
                <Inline tokens={(token as Tokens.Em).tokens} />
              </Text>
            );
          case 'del':
            return (
              <Text key={i} strikethrough color={theme.foreground}>
                <Inline tokens={(token as Tokens.Del).tokens} />
              </Text>
            );
          case 'codespan':
            return (
              <Text key={i} bold color={theme.foreground}>
                {decode((token as Tokens.Codespan).text)}
              </Text>
            );
          case 'link':
            return (
              <Text key={i} underline color={theme.foreground}>
                {decode((token as Tokens.Link).text)}
              </Text>
            );
          case 'br':
            return (
              <Text key={i} color={theme.foreground}>
                {'\n'}
              </Text>
            );
          default:
            return (
              <Text key={i} color={theme.foreground}>
                {'text' in token
                  ? decode((token as Tokens.Text).text)
                  : ''}
              </Text>
            );
        }
      })}
    </>
  );
}

function Block({token, width}: {token: Token; width: number}) {
  switch (token.type) {
    case 'heading':
      return (
        <Text bold color={theme.foreground}>
          <Inline tokens={(token as Tokens.Heading).tokens} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text color={theme.foreground}>
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </Text>
      );
    case 'text': {
      const t = token as Tokens.Text;
      return (
        <Text color={theme.foreground}>
          {t.tokens ? <Inline tokens={t.tokens} /> : decode(t.text)}
        </Text>
      );
    }
    case 'list': {
      const t = token as Tokens.List;
      return (
        <Box flexDirection="column">
          {t.items.map((item, i) => {
            const marker = t.ordered ? `${Number(t.start || 1) + i}. ` : '• ';
            const inner = Math.max(1, width - stringWidth(marker));
            return (
              <Box key={i}>
                <Text color={theme.foreground}>{marker}</Text>
                <Box flexDirection="column" width={inner}>
                  {item.tokens.map((child, j) => (
                    <Block key={j} token={child} width={inner} />
                  ))}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }
    case 'code': {
      const t = token as Tokens.Code;
      return (
        <Box
          flexDirection="column"
          marginLeft={2}
          width={Math.max(1, width - 2)}
        >
          {t.text.split('\n').map((line, i) => (
            <Text key={i} color={theme.foreground}>
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const inner = Math.max(1, width - 2);
      return (
        <Box>
          <Text color={theme.muted}>{'│ '}</Text>
          <Box flexDirection="column" width={inner}>
            {t.tokens.map((child, i) => (
              <Block key={i} token={child} width={inner} />
            ))}
          </Box>
        </Box>
      );
    }
    case 'hr':
      return <Text color={theme.muted}>────────</Text>;
    case 'space':
      return <Text color={theme.foreground}> </Text>;
    default:
      return (
        <Text color={theme.foreground}>
          {'text' in token
            ? decode((token as Tokens.Text).text)
            : ''}
        </Text>
      );
  }
}

export function Markdown({text}: {text: string}) {
  const {stdout} = useStdout();
  const width =
    stdout.columns !== undefined && stdout.columns > 0
      ? stdout.columns
      : DEFAULT_TERMINAL_COLUMNS;
  const tokens = marked.lexer(text);
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <Block key={i} token={token} width={width} />
      ))}
    </Box>
  );
}
