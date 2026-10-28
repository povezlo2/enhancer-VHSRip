import type { FaceModelId } from '../../shared/types';

/** File names of the face models inside bin/faces (downloaded by `npm run setup`). */
export const FACE_DETECTOR = 'face_detection_yunet_2023mar.onnx';

export const FACE_RESTORERS: Record<FaceModelId, string> = {
  gfpgan: 'gfpgan_1.4.onnx',
  codeformer: 'codeformer.onnx',
};
