// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0

import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import SourceLinks from './SourceLinks.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'doc-footer-before': () => h(SourceLinks),
  }),
};
