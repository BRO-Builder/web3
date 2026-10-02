import { Link, NavLink, Outlet } from "react-router-dom";

export function AppLayout() {
  return <>
    <header>
      <Link to="/"><img src="https://www.brobuilder.llc/images/logo2.png" alt="BRO Builder LLC" /></Link>
      <nav aria-label="Primary navigation">
        <NavLink to="/">Tools</NavLink>
        <NavLink to="/exchange-dex">Exchange</NavLink>
        <NavLink to="/liquidity-dex">Liquidity</NavLink>
      </nav>
      <div className="tag">Web3 Portal</div>
    </header>
    <Outlet />
    <footer>BRO Builder LLC - tools for internal / partner use.</footer>
  </>;
}