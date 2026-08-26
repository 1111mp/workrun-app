import { Avatar as DicebearAvatar, Style } from '@dicebear/core';
import clayDefinition from '@dicebear/styles/clay.json' with { type: 'json' };

const clayStyle = new Style(clayDefinition);

export function localProfileAvatarUrl(avatarId: string) {
  return new DicebearAvatar(clayStyle, { seed: avatarId }).toDataUri();
}
