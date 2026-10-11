import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "./shared/AppLayout";
import { HomePage } from "./pages/HomePage";
import { DeploymentPage } from "./pages/DeploymentPage";
import { SetupPage } from "./pages/SetupPage";
import { ExchangePage } from "./pages/ExchangePage";
import { LiquidityPage } from "./pages/LiquidityPage";
import { VotingPage } from "./pages/VotingPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectsSetupPage } from "./pages/ProjectsSetupPage";
import "./styles.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="deployment-ft" element={<DeploymentPage kind="token" />} />
          <Route path="deployment-ft.html" element={<DeploymentPage kind="token" />} />
          <Route path="deployment-dex" element={<DeploymentPage kind="dex" />} />
          <Route path="deployment-dex.html" element={<DeploymentPage kind="dex" />} />
          <Route path="deployment-delegator" element={<DeploymentPage kind="delegator" />} />
          <Route path="deployment-delegator.html" element={<DeploymentPage kind="delegator" />} />
          <Route path="deployment-market" element={<DeploymentPage kind="market" />} />
          <Route path="deployment-market.html" element={<DeploymentPage kind="market" />} />
          <Route path="deployment-funding" element={<DeploymentPage kind="funding" />} />
          <Route path="deployment-funding.html" element={<DeploymentPage kind="funding" />} />
          <Route path="deployment-projects" element={<DeploymentPage kind="projects" />} />
          <Route path="deployment-projects.html" element={<DeploymentPage kind="projects" />} />
          <Route path="deployment-projects-setup" element={<ProjectsSetupPage />} />
          <Route path="deployment-projects-setup.html" element={<ProjectsSetupPage />} />
          <Route path="deployment-dex-setup" element={<SetupPage />} />
          <Route path="deployment-dex-setup.html" element={<SetupPage />} />
          <Route path="exchange-dex" element={<ExchangePage />} />
          <Route path="exchange-dex.html" element={<ExchangePage />} />
          <Route path="liquidity-dex" element={<LiquidityPage />} />
          <Route path="liquidity-dex.html" element={<LiquidityPage />} />
          <Route path="vote" element={<VotingPage />} />
          <Route path="vote.html" element={<VotingPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects.html" element={<ProjectsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);