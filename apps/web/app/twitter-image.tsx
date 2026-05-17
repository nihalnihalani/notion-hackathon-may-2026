import { renderSocialImage } from '@/lib/social-image';

export const alt = 'Forge — describe an agent, ship a deployed Notion Custom Agent in 90 seconds';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function TwitterImage() {
  return renderSocialImage();
}
