default // Inventory replacement source.
{
    state_entry()
    {
        llLinksetDataWrite("candidate:version", "new");
    }
}
