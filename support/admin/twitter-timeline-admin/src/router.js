import { createRouter, createWebHistory } from "vue-router";
import HistoryView from "./views/HistoryView.vue";
import TargetsView from "./views/TargetsView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/targets" },
    { path: "/targets", name: "targets", component: TargetsView },
    { path: "/history", name: "history", component: HistoryView },
    { path: "/:pathMatch(.*)*", redirect: "/targets" }
  ],
  scrollBehavior: () => ({ top: 0 })
});

export default router;
