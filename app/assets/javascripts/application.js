//
// For guidance on how to add JavaScript see:
// https://prototype-kit.service.gov.uk/docs/adding-css-javascript-and-images
//

window.GOVUKPrototypeKit.documentReady(() => {
  // After a search or filter, move focus to the results count so screen readers
  // announce it immediately and keyboard users don't have to re-navigate down the page.
  if (window.location.search) {
    const results = document.getElementById('search-results')
    if (results) results.focus()
  }
})
