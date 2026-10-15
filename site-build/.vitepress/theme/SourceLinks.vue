<!-- © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup>
import { computed } from 'vue';
import { useData } from 'vitepress';

const { page } = useData();
const repository = 'https://github.com/rucorp/mock-services';
const sourcePath = computed(() => page.value.frontmatter.sourcePath || 'README.md');
const encodedSourcePath = computed(() => sourcePath.value.split('/').map(encodeURIComponent).join('/'));
const sourceUrl = computed(() => `${repository}/blob/main/${encodedSourcePath.value}`);
const editUrl = computed(() => `${repository}/edit/main/${encodedSourcePath.value}`);
</script>

<template>
  <nav class="doc-source-links" aria-label="Ссылки на исходный документ">
    <a :href="editUrl" target="_blank" rel="noopener noreferrer">Редактировать на GitHub</a>
    <a :href="sourceUrl" target="_blank" rel="noopener noreferrer">Исходник (.md)</a>
  </nav>
</template>
