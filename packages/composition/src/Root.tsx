import { CompositionPropsSchema } from '@vc/config';
import React from 'react';
import { Composition, staticFile } from 'remotion';
import { demoProps } from './demo';
import { COMPOSITION_ID, calculateVideoMetadata } from './metadata';
import { VideoComposition } from './Video';

/**
 * Remotion Studio builds its props editor from CompositionPropsSchema (@remotion/zod-types colour
 * pickers included): the same schema that validates API requests and drives the web form.
 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={VideoComposition}
    schema={CompositionPropsSchema}
    defaultProps={demoProps(staticFile)}
    calculateMetadata={({ props }) => calculateVideoMetadata(props)}
    durationInFrames={360}
    fps={30}
    width={1920}
    height={1080}
  />
);
