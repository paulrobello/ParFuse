const got = require('got');
import { sep as pathSep } from 'path';
import { mkFile, Node } from './fuseUtils';
import { updateNodeContent } from './index';

let fortunes: string[] = [];
export const getFortune = async (): Promise<string> => {
  try {
    if (!fortunes || !fortunes.length) {
      const response = await got(
        'https://raw.githubusercontent.com/ruanyf/fortunes/master/data/fortunes'
      );
      fortunes = response.body.split(/^%\r?\n/m);
    }
    return fortunes[Math.floor(Math.random() * fortunes.length)];
    // console.log(fortunes);
  } catch (error) {
    // console.log(error.response.body);
    return 'Error fetching fortunes';
  }
};

let fortuneNode: Node | null;
export const mkFortuneNode = async (): Promise<Node> => {
  return (fortuneNode = mkFile(pathSep, 'fortune', await getFortune()));
};

export const newFortune = async (): Promise<void> => {
  if (!fortuneNode) {
    await mkFortuneNode();
    return;
  }
  updateNodeContent(fortuneNode, await getFortune());
};
