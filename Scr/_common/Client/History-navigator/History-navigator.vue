<template>
	<span>
		<a
			v-if="HistoryNavigator.canGoBack"
			class="navbar-item"
			title="Go back"
			@click="HistoryNavigator.back()"
		>
			<app-colticon icon="chevron-left" />
		</a>
		<a
			v-if="HistoryNavigator.canGoForward"
			class="navbar-item"
			title="Go forward"
			@click="HistoryNavigator.forward()"
		>
			<app-colticon icon="chevron-right" />
		</a>
	</span>
</template>

<script lang="ts" src="./history-navigator"></script>
