import { actions, findNode, useStore } from '../state'

export function TabBar() {
  const tabs = useStore(s => s.tabs)
  const activeTab = useStore(s => s.activeTab)
  const tree = useStore(s => s.tree)

  return (
    <div className="tabbar" role="tablist">
      {tabs.map(tab => {
        const node = findNode(tree, tab.path)
        const parent = tab.path.includes('/') ? findNode(tree, tab.path.slice(0, tab.path.lastIndexOf('/'))) : undefined
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={tab.path === activeTab}
            className={`tab${tab.path === activeTab ? ' active' : ''}`}
            onClick={() => useStore.setState({ activeTab: tab.path })}
            onAuxClick={e => e.button === 1 && actions.closeTab(tab.path)}
            title={tab.path}
          >
            {parent && <span className="tab-parent">{parent.title} /</span>}
            <span>{node?.title ?? tab.path}</span>
            <button
              className="tab-close"
              aria-label="Close tab"
              onClick={e => {
                e.stopPropagation()
                actions.closeTab(tab.path)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
