// Markdown → 适合朗读的纯文本：代码块和链接地址不念，标记符号去掉。
export const toSpeech = (markdown: string): string =>
  markdown
    .replace(/```[\s\S]*?(```|$)/g, '\n（代码略）\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '（链接）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map(cell => cell.trim()).join('，'))
    .replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]*/gm, '')
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|~~|\*)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
